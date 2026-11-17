// HTTP transport: routing, auth, fast paths, and response writing.
// Written fresh in Go for the v6 native core; behaviour mirrors the
// Node forge (app.ts) that passed 120/120 conformance.
package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const maxBodyBytes = 64 * 1024 * 1024

type forgeServer struct {
	state *forgeState
}

func (fs *forgeServer) writeResp(w http.ResponseWriter, resp httpResponse) {
	h := w.Header()
	h.Set("x-github-request-id", fs.state.requestID())
	for k, v := range resp.headers {
		h.Set(k, v)
	}
	if resp.body == nil {
		// No body (204/202/DELETE): write headers only.
		w.WriteHeader(resp.status)
		return
	}
	h.Set("content-length", strconv.Itoa(len(resp.body)))
	w.WriteHeader(resp.status)
	w.Write(resp.body)
}

func (fs *forgeServer) writeErr(w http.ResponseWriter, status int, message string) {
	fs.writeResp(w, errJSON(status, message))
}

func (fs *forgeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if rec := recover(); rec != nil {
			// Never let a handler panic kill the connection without a
			// response: answer 500 like the Node try/catch does.
			func() {
				defer func() { _ = recover() }()
				fs.writeErr(w, 500, fmt.Sprintf("%v", rec))
			}()
		}
	}()

	// Raw request-target, like Node's req.url: split path and query.
	rawURI := r.URL.RequestURI()
	qIndex := strings.IndexByte(rawURI, '?')
	path := rawURI
	query := ""
	if qIndex >= 0 {
		path = rawURI[:qIndex]
		query = rawURI[qIndex+1:]
	}
	method := r.Method

	// Health probe: no auth, always 200.
	if path == "/healthz" && method == "GET" {
		fs.writeResp(w, jsonResp(200, map[string]any{"ok": true}, nil))
		return
	}

	// Auth for everything else.
	if r.Header.Get("Authorization") != fs.state.authHeader {
		fs.writeErr(w, 401, "unauthorized")
		return
	}

	// Body for non-GET/HEAD.
	var body []byte
	if method != "GET" && method != "HEAD" {
		limited := io.LimitReader(r.Body, maxBodyBytes+1)
		b, err := io.ReadAll(limited)
		if err != nil {
			fs.writeErr(w, 400, "could not read request body")
			return
		}
		if len(b) > maxBodyBytes {
			fs.writeErr(w, 400, "request body too large")
			return
		}
		body = b
	} else {
		body = []byte{}
	}

	// Fast path: GET / POST a single issue (the bench's hot shapes).
	// Exact segment match, no query string, no percent-escapes.
	if query == "" && !strings.Contains(path, "%") && (method == "GET" || method == "POST") {
		if fast := fastIssueRoute(path); fast != nil {
			repo := fs.state.getRepo(fast.owner, fast.repoName)
			if repo != nil {
				if method == "GET" && fast.number != nil {
					repo.mu.RLock()
					iss, ok := repo.issues[*fast.number]
					var buf []byte
					if ok {
						buf = append([]byte(nil), iss.json...)
					}
					repo.mu.RUnlock()
					if ok {
						fs.writeResp(w, jsonRespRaw(200, buf))
						return
					}
				} else if method == "POST" && fast.number == nil {
					parsed, ok := parseJSONBody(body)
					if ok {
						pbody := bodyMap(parsed)
						title, _ := pbody["title"].(string)
						if title != "" {
							var labels []string
							if arr, isArr := pbody["labels"].([]any); isArr {
								for _, l := range arr {
									labels = append(labels, toStringJS(l))
								}
							}
							repo.mu.RLock()
							labelsOK := true
							for _, l := range labels {
								if _, has := repo.labels[l]; !has {
									labelsOK = false
									break
								}
							}
							repo.mu.RUnlock()
							if labelsOK {
								bodyText, _ := pbody["body"].(string)
								iss := fs.state.createIssue(repo, title, bodyText, labels)
								fs.writeResp(w, jsonRespRaw(201, iss.json))
								return
							}
						}
					}
				}
			}
		}
	}

	// Git smart HTTP: /{owner}/{repo}.git/...
	if m := gitPathRe.FindStringSubmatch(path); m != nil {
		owner, _ := unescapeSegment(m[1])
		repoName, _ := unescapeSegment(m[2])
		tail := m[3]
		repo := fs.state.getRepo(owner, repoName)
		if repo == nil {
			fs.writeErr(w, 404, "not found")
			return
		}
		fs.serveGit(w, r, repo, tail, query, method, body)
		return
	}

	// Generic router: lowercased headers copy + httpRequest.
	headers := map[string]string{}
	for k, vs := range r.Header {
		lk := strings.ToLower(k)
		if len(vs) == 1 {
			headers[lk] = vs[0]
		} else {
			headers[lk] = strings.Join(vs, ", ")
		}
	}
	httpReq := &httpRequest{method: method, path: path, query: query, headers: headers, body: body, host: r.Host}

	// REST
	if path == "/api/v3" || strings.HasPrefix(path, "/api/v3/") {
		fs.writeResp(w, handleRest(fs.state, httpReq))
		return
	}

	// GraphQL
	if path == "/api/graphql" {
		if method != "POST" {
			fs.writeErr(w, 405, "method not allowed")
			return
		}
		fs.writeResp(w, handleGraphQL(fs.state, body))
		return
	}

	// MCP
	if path == "/mcp" {
		fs.writeResp(w, handleMCP(fs.state, httpReq))
		return
	}

	fs.writeErr(w, 404, "not found")
}

var gitPathRe = regexp.MustCompile(`^/([^/]+)/([^/]+)\.git/(.*)$`)

func unescapeSegment(s string) (string, bool) {
	dec, err := url.PathUnescape(s)
	if err != nil {
		return s, false
	}
	return dec, true
}

type fastIssue struct {
	owner    string
	repoName string
	number   *int
}

// fastIssueRoute parses the bench's hot issue paths without splitting or
// decoding: /api/v3/repos/<owner>/<repo>/issues or .../issues/<digits>.
func fastIssueRoute(path string) *fastIssue {
	const prefix = "/api/v3/repos/"
	if !strings.HasPrefix(path, prefix) {
		return nil
	}
	rest := path[len(prefix):]
	s1 := strings.IndexByte(rest, '/')
	if s1 <= 0 {
		return nil
	}
	owner := rest[:s1]
	s2 := strings.IndexByte(rest[s1+1:], '/')
	if s2 < 0 {
		return nil
	}
	s2 += s1 + 1
	repoName := rest[s1+1 : s2]
	if repoName == "" {
		return nil
	}
	tail := rest[s2+1:]
	if tail == "issues" {
		return &fastIssue{owner: owner, repoName: repoName}
	}
	if !strings.HasPrefix(tail, "issues/") {
		return nil
	}
	numText := tail[len("issues/"):]
	if numText == "" {
		return nil
	}
	for i := 0; i < len(numText); i++ {
		if numText[i] < '0' || numText[i] > '9' {
			return nil
		}
	}
	n, err := strconv.Atoi(numText)
	if err != nil {
		return nil
	}
	return &fastIssue{owner: owner, repoName: repoName, number: &n}
}

func queryService(query string) string {
	key := "service="
	i := strings.Index(query, key)
	for i >= 0 {
		if i == 0 || query[i-1] == '&' {
			end := strings.IndexByte(query[i+len(key):], '&')
			if end < 0 {
				return query[i+len(key):]
			}
			return query[i+len(key) : i+len(key)+end]
		}
		i = strings.Index(query[i+1:], key)
		if i >= 0 {
			i++
		}
	}
	return ""
}

func wantsV2(r *http.Request) bool {
	gp := r.Header.Get("Git-Protocol")
	return gp == "version=2" || strings.Contains(gp, "version=2")
}

func (fs *forgeServer) serveGit(w http.ResponseWriter, r *http.Request, repo *repo, tail, query, method string, body []byte) {
	if tail == "info/refs" && method == "GET" {
		service := queryService(query)
		if service == "git-upload-pack" {
			repo.mu.RLock()
			var adv []byte
			if wantsV2(r) {
				adv = v2Advertisement
			} else {
				adv = repo.advertisementV0("git-upload-pack")
			}
			repo.mu.RUnlock()
			fs.writeResp(w, httpResponse{status: 200, headers: map[string]string{"content-type": "application/x-git-upload-pack-advertisement"}, body: adv})
			return
		}
		if service == "git-receive-pack" {
			repo.mu.RLock()
			adv := repo.advertisementV0("git-receive-pack")
			repo.mu.RUnlock()
			fs.writeResp(w, httpResponse{status: 200, headers: map[string]string{"content-type": "application/x-git-receive-pack-advertisement"}, body: adv})
			return
		}
		fs.writeErr(w, 404, "not found")
		return
	}
	if tail == "git-upload-pack" && method == "POST" {
		packets, _, err := parsePktLines(body)
		if err != nil {
			fs.writeErr(w, 400, err.Error())
			return
		}
		lines := pktLinesToText(packets)
		fetchReq := parseFetchRequest(lines, wantsV2(r))
		repo.mu.RLock()
		resp := repo.handleFetch(fetchReq)
		repo.mu.RUnlock()
		fs.writeResp(w, httpResponse{status: 200, headers: map[string]string{"content-type": "application/x-git-upload-pack-result"}, body: resp})
		return
	}
	if tail == "git-receive-pack" && method == "POST" {
		commands, pack, err := parsePushRequest(body)
		if err != nil {
			fs.writeErr(w, 400, err.Error())
			return
		}
		repo.mu.Lock()
		results := repo.applyPush(commands, pack)
		report := pushReportBuffer(results)
		repo.mu.Unlock()
		fs.writeResp(w, httpResponse{status: 200, headers: map[string]string{"content-type": "application/x-git-receive-pack-result"}, body: report})
		return
	}
	fs.writeErr(w, 404, "not found")
}
