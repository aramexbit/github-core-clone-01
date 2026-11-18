// HTTP transport: routing, auth, fast paths, and response writing.
// Written fresh in Go for the v6 native core; behaviour mirrors the
// Node forge (app.ts) that passed 120/120 conformance.
package main

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const maxBodyBytes = 64 * 1024 * 1024

type forgeServer struct {
	state *forgeState
}

// dispatch routes one parsed raw request and returns the response.
// The raw server (rawhttp.go) serializes the response in one write.
func (fs *forgeServer) dispatch(req *rawRequest) (resp httpResponse) {
	defer func() {
		if rec := recover(); rec != nil {
			// Never let a handler panic kill the connection without a
			// response: answer 500 like the Node try/catch does.
			resp = errJSON(500, fmt.Sprintf("%v", rec))
		}
	}()

	path := req.path
	query := req.query
	method := req.method

	// Health probe: no auth, always 200.
	if path == "/healthz" && method == "GET" {
		return jsonResp(200, map[string]any{"ok": true}, nil)
	}

	// Auth for everything else.
	if auth, _ := req.header("authorization"); auth != fs.state.authHeader {
		return errJSON(401, "unauthorized")
	}

	// The raw server already read the body (Content-Length or chunked).
	body := req.body

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
						return jsonRespRaw(200, buf)
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
								return jsonRespRaw(201, iss.json)
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
			return errJSON(404, "not found")
		}
		return fs.serveGit(req, repo, tail, query)
	}

	// Generic router: lowercased headers copy + httpRequest.
	headers := req.headerMap()
	httpReq := &httpRequest{method: method, path: path, query: query, headers: headers, body: body, host: req.host}

	// REST
	if path == "/api/v3" || strings.HasPrefix(path, "/api/v3/") {
		return handleRest(fs.state, httpReq)
	}

	// GraphQL
	if path == "/api/graphql" {
		if method != "POST" {
			return errJSON(405, "method not allowed")
		}
		return handleGraphQL(fs.state, body)
	}

	// MCP
	if path == "/mcp" {
		return handleMCP(fs.state, httpReq)
	}

	return errJSON(404, "not found")
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

func wantsV2(req *rawRequest) bool {
	gp, _ := req.header("git-protocol")
	return gp == "version=2" || strings.Contains(gp, "version=2")
}

func (fs *forgeServer) serveGit(req *rawRequest, repo *repo, tail, query string) httpResponse {
	method := req.method
	body := req.body
	if tail == "info/refs" && method == "GET" {
		service := queryService(query)
		if service == "git-upload-pack" {
			repo.mu.RLock()
			var adv []byte
			if wantsV2(req) {
				adv = v2Advertisement
			} else {
				adv = repo.advertisementV0("git-upload-pack")
			}
			repo.mu.RUnlock()
			return httpResponse{status: 200, headers: map[string]string{"content-type": "application/x-git-upload-pack-advertisement"}, body: adv}
		}
		if service == "git-receive-pack" {
			repo.mu.RLock()
			adv := repo.advertisementV0("git-receive-pack")
			repo.mu.RUnlock()
			return httpResponse{status: 200, headers: map[string]string{"content-type": "application/x-git-receive-pack-advertisement"}, body: adv}
		}
		return errJSON(404, "not found")
	}
	if tail == "git-upload-pack" && method == "POST" {
		packets, _, err := parsePktLines(body)
		if err != nil {
			return errJSON(400, err.Error())
		}
		lines := pktLinesToText(packets)
		fetchReq := parseFetchRequest(lines, wantsV2(req))
		repo.mu.RLock()
		resp := repo.handleFetch(fetchReq)
		repo.mu.RUnlock()
		return httpResponse{status: 200, headers: map[string]string{"content-type": "application/x-git-upload-pack-result"}, body: resp}
	}
	if tail == "git-receive-pack" && method == "POST" {
		commands, pack, err := parsePushRequest(body)
		if err != nil {
			return errJSON(400, err.Error())
		}
		repo.mu.Lock()
		results := repo.applyPush(commands, pack)
		report := pushReportBuffer(results)
		repo.mu.Unlock()
		return httpResponse{status: 200, headers: map[string]string{"content-type": "application/x-git-receive-pack-result"}, body: report}
	}
	return errJSON(404, "not found")
}
