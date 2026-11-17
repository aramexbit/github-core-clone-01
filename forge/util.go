// Shared helpers: hashing, base64, pkt-lines, timestamps, JSON.
// Written fresh in Go for the v6 native core; behaviour mirrors the
// Node forge (app.ts) that passed 120/120 conformance.
package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	zeroOID     = "0000000000000000000000000000000000000000"
	viewerLogin = "adaiversen"
	viewerID    = 1000
	viewerName  = "ada iversen"
	viewerEmail = "adaiversen@example.invalid"
	agentName   = "github-core-clone/3.0.0"
	defBranch   = "main"
)

// isoNow renders like JavaScript's new Date().toISOString():
// 2026-11-17T06:54:49.123Z — always UTC, exactly 3 fractional digits.
func isoNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// isoUnix returns the current Unix time in seconds.
func isoUnix() int64 { return time.Now().Unix() }

func sha1Hex(data []byte) string {
	sum := sha1.Sum(data)
	return hex.EncodeToString(sum[:])
}

// hashObject is the git object id: sha1("<type> <len>\0" + data).
func hashObject(typ string, data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s %d\x00", typ, len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

var hex40Re = regexp.MustCompile(`^[0-9a-f]{40}$`)

func isOID(v string) bool { return hex40Re.MatchString(v) }

func b64encode(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func b64decode(s string) string {
	clean := strings.Map(func(r rune) rune {
		switch r {
		case '\r', '\n', '\t', ' ':
			return -1
		}
		return r
	}, s)
	b, err := base64.StdEncoding.DecodeString(clean)
	if err != nil {
		return ""
	}
	return string(b)
}

func b64urlEncode(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

// marshalJSON encodes like JSON.stringify: no HTML escaping, struct field
// order preserved, no trailing newline.
func marshalJSON(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return []byte("null")
	}
	b := buf.Bytes()
	if len(b) > 0 && b[len(b)-1] == '\n' {
		b = b[:len(b)-1]
	}
	return b
}

// jsonString renders one string value exactly like JSON.stringify does.
func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// ------------------------------------------------------------ pkt-line

func pktLine(payload []byte) []byte {
	out := make([]byte, 4+len(payload))
	copy(out[4:], payload)
	copy(out[:4], fmt.Sprintf("%04x", len(payload)+4))
	return out
}

func pktLineStr(s string) []byte { return pktLine([]byte(s)) }

var pktFlush = []byte("0000")
var pktDelim = []byte("0001")

// pktLineBanded builds one sideband pkt-line for a slice of the pack:
// 4-byte hex length + band byte 1 + raw bytes, single allocation.
func pktLineBanded(pack []byte, off, ln int) []byte {
	pkt := make([]byte, 4+1+ln)
	copy(pkt[5:], pack[off:off+ln])
	copy(pkt[:4], fmt.Sprintf("%04x", ln+5))
	pkt[4] = 1
	return pkt
}

type pktPacket struct {
	kind    string // "flush" | "delim" | "response-end" | "data"
	payload []byte // nil unless data
}

// parsePktLines parses pkt-lines from the start of buf. It returns the
// packets and the offset just past the first flush (or len(buf)).
// Malformed input is an error, matching the Node implementation.
func parsePktLines(buf []byte) ([]pktPacket, int, error) {
	var packets []pktPacket
	off := 0
	for off+4 <= len(buf) {
		head := string(buf[off : off+4])
		for i := 0; i < 4; i++ {
			c := head[i]
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				return nil, 0, fmt.Errorf("invalid pkt-line length %q", head)
			}
		}
		var ln int
		fmt.Sscanf(head, "%x", &ln)
		if ln == 0 {
			packets = append(packets, pktPacket{kind: "flush"})
			return packets, off + 4, nil
		}
		if ln == 1 {
			packets = append(packets, pktPacket{kind: "delim"})
			off += 4
			continue
		}
		if ln == 2 {
			packets = append(packets, pktPacket{kind: "response-end"})
			off += 4
			continue
		}
		if ln == 3 || ln > 65520 {
			return nil, 0, fmt.Errorf("invalid pkt-line length %d", ln)
		}
		if off+ln > len(buf) {
			return nil, 0, fmt.Errorf("truncated pkt-line")
		}
		packets = append(packets, pktPacket{kind: "data", payload: buf[off+4 : off+ln]})
		off += ln
	}
	if off != len(buf) {
		return nil, 0, fmt.Errorf("truncated pkt-line header")
	}
	return packets, off, nil
}

// pktLinesToText returns the data payloads as strings, in order.
func pktLinesToText(packets []pktPacket) []string {
	out := make([]string, 0, len(packets))
	for _, p := range packets {
		if p.kind == "data" && p.payload != nil {
			out = append(out, string(p.payload))
		}
	}
	return out
}
