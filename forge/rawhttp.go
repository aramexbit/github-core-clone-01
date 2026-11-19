// Raw HTTP/1.1 transport: hand-rolled zero-alloc server on net.
// Written fresh in Go for v7; replaces net/http (Stage 1).
// Behaviour mirrors the net/http path it replaces: same routes, same
// status codes, same bodies and headers (x-github-request-id,
// content-type, content-length, date), keep-alive + pipelining.
// The dispatch logic lives in http.go (forgeServer.dispatch); this file
// only parses requests and serializes responses.
package main

import (
	"bytes"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maxHeaderBytes = 64 * 1024

var crlfcrlf = []byte("\r\n\r\n")
var badRequestResp = []byte("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
var continueResp = []byte("HTTP/1.1 100 Continue\r\n\r\n")

// Pooled per-connection read buffers (32 KiB initial capacity).
var connBufPool = sync.Pool{New: func() any { b := make([]byte, 0, 32768); return &b }}

// Pooled response scratch buffers (4 KiB initial capacity).
var respBufPool = sync.Pool{New: func() any { b := make([]byte, 0, 4096); return &b }}

// Cached Date header value, refreshed at most once per second.
var dateMu sync.Mutex
var dateSec atomic.Int64
var dateVal atomic.Value // string

func httpDate() string {
	now := time.Now()
	sec := now.Unix()
	if sec == dateSec.Load() {
		if s, ok := dateVal.Load().(string); ok && s != "" {
			return s
		}
	}
	dateMu.Lock()
	defer dateMu.Unlock()
	if sec != dateSec.Load() {
		dateSec.Store(sec)
		dateVal.Store(now.UTC().Format("Mon, 02 Jan 2006 15:04:05 GMT"))
	}
	return dateVal.Load().(string)
}

type rawHeader struct {
	name  string // lowercased
	value string
}

type rawRequest struct {
	method    string
	path      string
	query     string
	host      string
	version11 bool
	keepAlive bool
	headers   []rawHeader
	body      []byte
}

// header returns the first value for a lowercased header name.
func (r *rawRequest) header(name string) (string, bool) {
	for _, h := range r.headers {
		if h.name == name {
			return h.value, true
		}
	}
	return "", false
}

// headerMap builds the lowercased header map the generic router expects
// (multi-values joined with ", ", like the old net/http path).
func (r *rawRequest) headerMap() map[string]string {
	out := make(map[string]string, len(r.headers))
	for _, h := range r.headers {
		if prev, ok := out[h.name]; ok {
			out[h.name] = prev + ", " + h.value
		} else {
			out[h.name] = h.value
		}
	}
	return out
}

func statusText(code int) string {
	switch code {
	case 200:
		return "OK"
	case 201:
		return "Created"
	case 202:
		return "Accepted"
	case 204:
		return "No Content"
	case 400:
		return "Bad Request"
	case 401:
		return "Unauthorized"
	case 404:
		return "Not Found"
	case 405:
		return "Method Not Allowed"
	case 500:
		return "Internal Server Error"
	default:
		return "Status"
	}
}

// buildResponse appends one complete HTTP/1.1 response (status line,
// headers, blank line, body) to dst and returns it. One socket write
// carries the whole response. Mirrors net/http's observable behaviour:
// Date + x-github-request-id on every response, Content-Length on every
// response except 204, no body bytes for HEAD.
func (fs *forgeServer) buildResponse(dst []byte, req *rawRequest, resp httpResponse) []byte {
	if req.version11 {
		dst = append(dst, "HTTP/1.1 "...)
	} else {
		dst = append(dst, "HTTP/1.0 "...)
	}
	dst = strconv.AppendInt(dst, int64(resp.status), 10)
	dst = append(dst, ' ')
	dst = append(dst, statusText(resp.status)...)
	dst = append(dst, "\r\n"...)
	dst = append(dst, "date: "...)
	dst = append(dst, httpDate()...)
	dst = append(dst, "\r\n"...)
	dst = append(dst, "x-github-request-id: req-"...)
	dst = strconv.AppendUint(dst, fs.state.requestSeq.Add(1), 10)
	dst = append(dst, "\r\n"...)
	for k, v := range resp.headers {
		dst = append(dst, k...)
		dst = append(dst, ": "...)
		dst = append(dst, v...)
		dst = append(dst, "\r\n"...)
	}
	if resp.status != 204 {
		dst = append(dst, "content-length: "...)
		if resp.body == nil {
			dst = append(dst, '0')
		} else {
			dst = strconv.AppendInt(dst, int64(len(resp.body)), 10)
		}
		dst = append(dst, "\r\n"...)
	}
	if !req.keepAlive {
		dst = append(dst, "connection: close\r\n"...)
	}
	dst = append(dst, "\r\n"...)
	if req.method != "HEAD" && resp.body != nil {
		dst = append(dst, resp.body...)
	}
	return dst
}

// serveRaw is the accept loop; it blocks until the listener errors.
func serveRaw(ln net.Listener, fs *forgeServer) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go serveConn(c, fs)
	}
}

func serveConn(c net.Conn, fs *forgeServer) {
	defer c.Close()
	bp := connBufPool.Get().(*[]byte)
	buf := (*bp)[:0]
	defer func() {
		if cap(buf) <= 1<<20 {
			*bp = buf[:0]
			connBufPool.Put(bp)
		}
	}()
	for {
		// 1. Read until the header block is complete.
		var hend int
		for {
			if i := bytes.Index(buf, crlfcrlf); i >= 0 {
				hend = i
				break
			}
			if len(buf) > maxHeaderBytes {
				c.Write(badRequestResp)
				return
			}
			if len(buf) == cap(buf) {
				nb := make([]byte, len(buf), cap(buf)*2)
				copy(nb, buf)
				buf = nb
			}
			n, err := c.Read(buf[len(buf):cap(buf)])
			if n > 0 {
				buf = buf[:len(buf)+n]
			}
			if err != nil {
				return
			}
		}
		headEnd := hend + 4

		// 2. Parse request line + headers.
		req, contentLength, chunked, expectContinue, ok := parseHead(buf[:hend])
		if !ok {
			c.Write(badRequestResp)
			return
		}
		if contentLength > maxBodyBytes {
			c.Write(badRequestResp)
			return
		}
		if expectContinue {
			c.Write(continueResp)
		}

		// 3. Read the body.
		var body []byte
		consumed := headEnd
		if chunked {
			b, used, err := readChunked(c, &buf, headEnd)
			if err != nil {
				c.Write(badRequestResp)
				return
			}
			body = b
			consumed = used
		} else if contentLength > 0 {
			need := headEnd + contentLength
			for len(buf) < need {
				if len(buf) == cap(buf) {
					nb := make([]byte, len(buf), cap(buf)*2)
					copy(nb, buf)
					buf = nb
				}
				n, err := c.Read(buf[len(buf):cap(buf)])
				if n > 0 {
					buf = buf[:len(buf)+n]
				}
				if err != nil {
					return
				}
			}
			body = buf[headEnd:need]
			consumed = need
		}
		req.body = body

		// 4. Dispatch and write one response.
		resp := fs.dispatch(req)
		rbp := respBufPool.Get().(*[]byte)
		out := (*rbp)[:0]
		out = fs.buildResponse(out, req, resp)
		_, werr := c.Write(out)
		if cap(out) <= 1<<20 {
			*rbp = out[:0]
			respBufPool.Put(rbp)
		}

		// 5. Consume the request bytes; leftover bytes (pipelined
		// requests) stay in the buffer for the next iteration.
		buf = append(buf[:0], buf[consumed:]...)
		if werr != nil || !req.keepAlive {
			return
		}
	}
}

// parseHead parses the request line and headers from head (which excludes
// the trailing CRLFCRLF). It returns the request, the declared body
// length (-1 if none), whether the body is chunked, whether the client
// expects a 100-continue, and whether the head parsed cleanly.
func parseHead(head []byte) (req *rawRequest, contentLength int, chunked bool, expectContinue bool, ok bool) {
	contentLength = -1
	// Request line.
	lineEnd := bytes.Index(head, []byte("\r\n"))
	if lineEnd < 0 {
		return nil, -1, false, false, false
	}
	line := head[:lineEnd]
	sp1 := bytes.IndexByte(line, ' ')
	if sp1 <= 0 {
		return nil, -1, false, false, false
	}
	sp2 := bytes.IndexByte(line[sp1+1:], ' ')
	if sp2 <= 0 {
		return nil, -1, false, false, false
	}
	sp2 += sp1 + 1
	method := string(line[:sp1])
	target := string(line[sp1+1 : sp2])
	// Version compared as bytes: the string conversion was 1 alloc/req
	// for a value that is only ever tested against two literals.
	ver := line[sp2+1:]
	var version11 bool
	switch {
	case bytes.Equal(ver, []byte("HTTP/1.1")):
		version11 = true
	case bytes.Equal(ver, []byte("HTTP/1.0")):
		version11 = false
	default:
		return nil, -1, false, false, false
	}
	// Target: origin-form or absolute-form.
	var host string
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		rest := target
		if strings.HasPrefix(rest, "http://") {
			rest = rest[len("http://"):]
		} else {
			rest = rest[len("https://"):]
		}
		slash := strings.IndexByte(rest, '/')
		if slash < 0 {
			host = rest
			target = "/"
		} else {
			host = rest[:slash]
			target = rest[slash:]
		}
	} else if !strings.HasPrefix(target, "/") {
		return nil, -1, false, false, false
	}
	path := target
	query := ""
	if qi := strings.IndexByte(target, '?'); qi >= 0 {
		path = target[:qi]
		query = target[qi+1:]
	}

	req = &rawRequest{method: method, path: path, query: query, host: host, version11: version11, headers: make([]rawHeader, 0, 8)}
	rest := head[lineEnd+2:]
	for len(rest) > 0 {
		eol := bytes.Index(rest, []byte("\r\n"))
		var hline []byte
		if eol < 0 {
			hline = rest
			rest = nil
		} else {
			hline = rest[:eol]
			rest = rest[eol+2:]
		}
		if len(hline) == 0 {
			continue
		}
		colon := bytes.IndexByte(hline, ':')
		if colon <= 0 {
			return nil, -1, false, false, false
		}
		name := strings.ToLower(string(bytes.Trim(hline[:colon], " \t")))
		value := string(bytes.Trim(hline[colon+1:], " \t"))
		req.headers = append(req.headers, rawHeader{name: name, value: value})
		switch name {
		case "host":
			if req.host == "" {
				req.host = value
			}
		case "content-length":
			if contentLength < 0 {
				n, err := strconv.Atoi(value)
				if err != nil || n < 0 {
					return nil, -1, false, false, false
				}
				contentLength = n
			}
		case "transfer-encoding":
			if strings.Contains(strings.ToLower(value), "chunked") {
				chunked = true
			}
		case "expect":
			if strings.EqualFold(value, "100-continue") {
				expectContinue = true
			}
		}
	}

	// Keep-alive: HTTP/1.1 defaults to keep-alive unless the client
	// says close; HTTP/1.0 defaults to close unless keep-alive.
	keepAlive := version11
	if connVal, found := req.header("connection"); found {
		lower := strings.ToLower(connVal)
		if strings.Contains(lower, "close") {
			keepAlive = false
		} else if strings.Contains(lower, "keep-alive") {
			keepAlive = true
		}
	}
	req.keepAlive = keepAlive
	return req, contentLength, chunked, expectContinue, true
}

// readChunked reads a chunked body starting at off in *buf (reading more
// from c as needed) and returns the assembled body, the offset just past
// the terminating chunk, and any error.
func readChunked(c net.Conn, buf *[]byte, off int) ([]byte, int, error) {
	var body []byte
	pos := off
	for {
		// Read one chunk-size line.
		for {
			if i := bytes.Index((*buf)[pos:], []byte("\r\n")); i >= 0 {
				break
			}
			if err := fillBuf(c, buf); err != nil {
				return nil, 0, err
			}
		}
		eol := bytes.Index((*buf)[pos:], []byte("\r\n"))
		sizeLine := string((*buf)[pos : pos+eol])
		if sc := strings.IndexByte(sizeLine, ';'); sc >= 0 {
			sizeLine = sizeLine[:sc]
		}
		size, err := strconv.ParseInt(strings.TrimSpace(sizeLine), 16, 64)
		if err != nil || size < 0 {
			return nil, 0, errBadChunk
		}
		pos += eol + 2
		if size == 0 {
			// Trailers until an empty line.
			for {
				if i := bytes.Index((*buf)[pos:], []byte("\r\n")); i == 0 {
					return body, pos + 2, nil
				} else if i > 0 {
					pos += i + 2
					continue
				}
				if err := fillBuf(c, buf); err != nil {
					return nil, 0, err
				}
			}
		}
		if len(body)+int(size) > maxBodyBytes {
			return nil, 0, errBadChunk
		}
		for len(*buf)-pos < int(size)+2 {
			if err := fillBuf(c, buf); err != nil {
				return nil, 0, err
			}
		}
		body = append(body, (*buf)[pos:pos+int(size)]...)
		pos += int(size) + 2 // skip chunk data + trailing CRLF
	}
}

var errBadChunk = errString("bad chunked encoding")

type errString string

func (e errString) Error() string { return string(e) }

// fillBuf reads more bytes into *buf, growing it if full.
func fillBuf(c net.Conn, buf *[]byte) error {
	b := *buf
	if len(b) == cap(b) {
		nb := make([]byte, len(b), cap(b)*2)
		copy(nb, b)
		b = nb
	}
	n, err := c.Read(b[len(b):cap(b)])
	if n > 0 {
		*buf = b[:len(b)+n]
	} else {
		*buf = b
	}
	return err
}
