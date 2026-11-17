// REST v3 API.
// Written fresh in Go for the v6 native core; behaviour mirrors the
// Node forge (app.ts) that passed 120/120 conformance.
package main

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

type httpRequest struct {
	method  string
	path    string
	query   string
	headers map[string]string // lowercased names
	body    []byte
	host    string
}

type httpResponse struct {
	status  int
	headers map[string]string
	body    []byte // nil = no body
}

func jsonResp(status int, obj any, extra map[string]string) httpResponse {
	h := map[string]string{"content-type": "application/json"}
	for k, v := range extra {
		h[k] = v
	}
	return httpResponse{status: status, headers: h, body: marshalJSON(obj)}
}

func jsonRespRaw(status int, body []byte) httpResponse {
	return httpResponse{status: status, headers: map[string]string{"content-type": "application/json"}, body: body}
}

func errJSON(status int, message string) httpResponse {
	return jsonResp(status, map[string]any{"message": message}, nil)
}

func noContentResp() httpResponse {
	return httpResponse{status: 204, headers: map[string]string{}, body: nil}
}

func parseQuery(query string) map[string]string {
	out := map[string]string{}
	if query == "" {
		return out
	}
	for _, pair := range strings.Split(query, "&") {
		if pair == "" {
			continue
		}
		if eq := strings.IndexByte(pair, '='); eq < 0 {
			k, _ := url.QueryUnescape(pair)
			out[k] = ""
		} else {
			k, _ := url.QueryUnescape(pair[:eq])
			v, _ := url.QueryUnescape(pair[eq+1:])
			out[k] = v
		}
	}
	return out
}

// parseJSONBody mirrors the Node helper: empty body -> null value, ok;
// malformed JSON -> not ok.
func parseJSONBody(body []byte) (any, bool) {
	if len(body) == 0 {
		return nil, true
	}
	var v any
	if err := jsonUnmarshal(body, &v); err != nil {
		return nil, false
	}
	return v, true
}

func jsonUnmarshal(b []byte, v any) error {
	return unmarshalJSON(b, v)
}

func splitPath(path string) ([]string, bool) {
	parts := strings.Split(path, "/")
	out := make([]string, 0, len(parts))
	for _, s := range parts {
		if s == "" {
			continue
		}
		dec, err := url.PathUnescape(s)
		if err != nil {
			return nil, false
		}
		out = append(out, dec)
	}
	return out, true
}

func linkHeader(base string, page, perPage, total int) string {
	lastPage := (total + perPage - 1) / perPage
	if lastPage < 1 {
		lastPage = 1
	}
	var parts []string
	if page < lastPage {
		parts = append(parts, fmt.Sprintf("<%s?page=%d&per_page=%d>; rel=\"next\"", base, page+1, perPage))
	}
	if page > 1 {
		parts = append(parts, fmt.Sprintf("<%s?page=%d&per_page=%d>; rel=\"prev\"", base, page-1, perPage))
	}
	parts = append(parts, fmt.Sprintf("<%s?page=%d&per_page=%d>; rel=\"last\"", base, lastPage, perPage))
	parts = append(parts, fmt.Sprintf("<%s?page=1&per_page=%d>; rel=\"first\"", base, perPage))
	return strings.Join(parts, ", ")
}

func toStringJS(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		if t {
			return "true"
		}
		return "false"
	case nil:
		return "null"
	default:
		return fmt.Sprintf("%v", t)
	}
}

func bodyMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func intQuery(q map[string]string, key string, def int) int {
	s, ok := q[key]
	if !ok {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

func handleRest(s *forgeState, req *httpRequest) httpResponse {
	segments, ok := splitPath(req.path)
	if !ok {
		return errJSON(500, "URI malformed")
	}
	if len(segments) == 0 || segments[0] != "api" || len(segments) < 2 || segments[1] != "v3" {
		return errJSON(404, "not found")
	}
	rest := segments[2:]
	query := parseQuery(req.query)
	method := req.method

	// ---- root / meta
	if len(rest) == 0 {
		if method != "GET" {
			return errJSON(404, "not found")
		}
		return jsonResp(200, map[string]any{
			"current_user_url": "/api/v3/user",
			"repository_url":   "/api/v3/repos/{owner}/{repo}",
			"rate_limit_url":   "/api/v3/rate_limit",
		}, map[string]string{"x-oauth-scopes": "repo, read:org"})
	}
	if len(rest) == 1 && rest[0] == "meta" {
		if method != "GET" {
			return errJSON(404, "not found")
		}
		return jsonResp(200, map[string]any{
			"verifiable_password_authentication": true,
			"installed_version":                  "3.0.0",
			"hooks":                              []string{"pre-receive"},
			"git":                                []string{"3.2.0"},
		}, nil)
	}

	// ---- /user
	if rest[0] == "user" {
		if len(rest) == 1 {
			if method != "GET" {
				return errJSON(404, "not found")
			}
			return jsonResp(200, map[string]any{
				"login":    viewerLogin,
				"id":       viewerID,
				"name":     viewerName,
				"email":    viewerEmail,
				"type":     "User",
				"html_url": "https://example.invalid/" + viewerLogin,
			}, nil)
		}
		if len(rest) == 2 && rest[1] == "repos" {
			if method == "GET" {
				page := intQuery(query, "page", 1)
				if page < 1 {
					page = 1
				}
				perPage := intQuery(query, "per_page", 30)
				if perPage < 1 {
					perPage = 1
				}
				if perPage > 100 {
					perPage = 100
				}
				s.mu.RLock()
				all := make([]*repo, 0, len(s.repos))
				for _, r := range s.repos {
					all = append(all, r)
				}
				s.mu.RUnlock()
				sortReposByCreated(all)
				start := (page - 1) * perPage
				end := start + perPage
				if start > len(all) {
					start = len(all)
				}
				if end > len(all) {
					end = len(all)
				}
				slice := all[start:end]
				origin := "http://" + req.host
				if req.host == "" {
					origin = "http://127.0.0.1"
				}
				base := origin + "/api/v3/user/repos"
				list := make([]map[string]any, len(slice))
				for i, r := range slice {
					r.mu.RLock()
					list[i] = repoToJSON(r)
					r.mu.RUnlock()
				}
				return jsonResp(200, list, map[string]string{"link": linkHeader(base, page, perPage, len(all))})
			}
			if method == "POST" {
				parsed, ok := parseJSONBody(req.body)
				if !ok {
					return errJSON(400, "invalid JSON body")
				}
				body := bodyMap(parsed)
				name, _ := body["name"].(string)
				if name == "" {
					return errJSON(422, "name is required")
				}
				if s.getRepo(viewerLogin, name) != nil {
					return errJSON(422, "name already exists on this account")
				}
				desc, _ := body["description"].(string)
				priv, _ := body["private"].(bool)
				r := s.createRepo(name, desc, priv)
				return jsonResp(201, repoToJSON(r), nil)
			}
			return errJSON(404, "not found")
		}
		return errJSON(404, "not found")
	}

	// ---- /repos/:owner/:repo/...
	if rest[0] != "repos" || len(rest) < 3 {
		return errJSON(404, "not found")
	}
	owner := rest[1]
	repoName := rest[2]
	r := s.getRepo(owner, repoName)
	if r == nil {
		return errJSON(404, "not found")
	}
	sub := rest[3:]

	// /repos/:owner/:repo
	if len(sub) == 0 {
		if method == "GET" {
			r.mu.RLock()
			j := repoToJSON(r)
			r.mu.RUnlock()
			return jsonResp(200, j, nil)
		}
		if method == "PATCH" {
			parsed, ok := parseJSONBody(req.body)
			if !ok {
				return errJSON(400, "invalid JSON body")
			}
			body := bodyMap(parsed)
			r.mu.Lock()
			if d, isStr := body["description"].(string); isStr {
				r.description = d
			}
			if p, isBool := body["private"].(bool); isBool {
				r.priv = p
			}
			r.mu.Unlock()
			r.mu.RLock()
			j := repoToJSON(r)
			r.mu.RUnlock()
			return jsonResp(200, j, nil)
		}
		if method == "DELETE" {
			s.mu.Lock()
			delete(s.repos, repoKey(owner, repoName))
			s.mu.Unlock()
			return noContentResp()
		}
		return errJSON(404, "not found")
	}

	// /branches
	if sub[0] == "branches" {
		if len(sub) == 1 {
			if method != "GET" {
				return errJSON(404, "not found")
			}
			r.mu.RLock()
			names := []string{}
			for n := range r.refs {
				if strings.HasPrefix(n, "refs/heads/") {
					names = append(names, n)
				}
			}
			sortStrings(names)
			out := make([]map[string]any, 0, len(names))
			for _, name := range names {
				oid := r.refs[name]
				message := ""
				if commit, ok := r.objects[oid]; ok && commit.typ == "commit" {
					message = parseCommit(commit.data).message
				}
				out = append(out, map[string]any{
					"name":      strings.TrimPrefix(name, "refs/heads/"),
					"commit":    map[string]any{"sha": oid, "message": message},
					"protected": false,
				})
			}
			r.mu.RUnlock()
			return jsonResp(200, out, nil)
		}
		if len(sub) == 2 {
			if method != "GET" {
				return errJSON(404, "not found")
			}
			r.mu.RLock()
			oid, ok := r.refs["refs/heads/"+sub[1]]
			var message string
			if ok {
				if commit, cok := r.objects[oid]; cok && commit.typ == "commit" {
					message = parseCommit(commit.data).message
				}
			}
			r.mu.RUnlock()
			if !ok {
				return errJSON(404, "branch not found")
			}
			return jsonResp(200, map[string]any{
				"name":      sub[1],
				"commit":    map[string]any{"sha": oid, "message": message},
				"protected": false,
			}, nil)
		}
		return errJSON(404, "not found")
	}

	// /commits
	if sub[0] == "commits" && len(sub) == 1 {
		if method != "GET" {
			return errJSON(404, "not found")
		}
		sha := query["sha"]
		if sha == "" {
			sha = r.defaultBranch
		}
		r.mu.RLock()
		tip, ok := resolveRef(r, "refs/heads/"+sha)
		if !ok && isOID(sha) {
			tip, ok = sha, true
		}
		if !ok {
			r.mu.RUnlock()
			return errJSON(404, "branch or commit not found")
		}
		chain := r.commitChain(tip, 30)
		out := make([]map[string]any, 0, len(chain))
		for _, ce := range chain {
			out = append(out, map[string]any{
				"sha": ce.oid,
				"commit": map[string]any{
					"message": ce.commit.message,
					"author":  map[string]any{"name": viewerName, "email": viewerEmail},
				},
			})
		}
		r.mu.RUnlock()
		return jsonResp(200, out, nil)
	}

	// /git/refs
	if sub[0] == "git" && len(sub) >= 2 && sub[1] == "refs" {
		if len(sub) == 2 {
			if method == "GET" {
				r.mu.RLock()
				names := make([]string, 0, len(r.refs))
				for n := range r.refs {
					names = append(names, n)
				}
				sortStrings(names)
				out := make([]map[string]any, 0, len(names))
				for _, name := range names {
					out = append(out, map[string]any{"ref": name, "object": map[string]any{"sha": r.refs[name], "type": "commit"}})
				}
				r.mu.RUnlock()
				return jsonResp(200, out, nil)
			}
			if method == "POST" {
				parsed, ok := parseJSONBody(req.body)
				if !ok {
					return errJSON(400, "invalid JSON body")
				}
				body := bodyMap(parsed)
				ref, _ := body["ref"].(string)
				sha, _ := body["sha"].(string)
				if ref == "" || sha == "" {
					return errJSON(422, "ref and sha are required")
				}
				r.mu.Lock()
				_, hasObj := r.objects[sha]
				if !hasObj {
					r.mu.Unlock()
					return errJSON(422, "object not found")
				}
				r.refs[ref] = sha
				r.invalidateCache()
				r.mu.Unlock()
				return jsonResp(201, map[string]any{"ref": ref, "object": map[string]any{"sha": sha, "type": "commit"}}, nil)
			}
			return errJSON(404, "not found")
		}
		if len(sub) >= 4 && sub[2] == "heads" {
			branch := strings.Join(sub[3:], "/")
			if method != "GET" {
				return errJSON(404, "not found")
			}
			r.mu.RLock()
			oid, ok := r.refs["refs/heads/"+branch]
			r.mu.RUnlock()
			if !ok {
				return errJSON(404, "ref not found")
			}
			return jsonResp(200, map[string]any{"ref": "refs/heads/" + branch, "object": map[string]any{"sha": oid, "type": "commit"}}, nil)
		}
		return errJSON(404, "not found")
	}

	// /contents/:path
	if sub[0] == "contents" {
		return handleContents(s, r, sub[1:], method, query, req)
	}

	// /labels
	if sub[0] == "labels" {
		if len(sub) == 1 {
			if method == "GET" {
				r.mu.RLock()
				out := make([]map[string]any, 0, len(r.labels))
				for _, l := range r.labels {
					out = append(out, map[string]any{"name": l.name, "color": l.color})
				}
				r.mu.RUnlock()
				return jsonResp(200, out, nil)
			}
			if method == "POST" {
				parsed, ok := parseJSONBody(req.body)
				if !ok {
					return errJSON(400, "invalid JSON body")
				}
				body := bodyMap(parsed)
				name, _ := body["name"].(string)
				color, _ := body["color"].(string)
				if color == "" {
					color = "ededed"
				}
				if name == "" {
					return errJSON(422, "name is required")
				}
				r.mu.Lock()
				r.labels[name] = &label{name: name, color: color}
				r.mu.Unlock()
				return jsonResp(201, map[string]any{"name": name, "color": color}, nil)
			}
			return errJSON(404, "not found")
		}
		return errJSON(404, "not found")
	}

	// /issues
	if sub[0] == "issues" {
		return handleIssues(s, r, sub[1:], method, query, req)
	}

	// /pulls
	if sub[0] == "pulls" {
		return handlePulls(s, r, sub[1:], method, query, req)
	}

	return errJSON(404, "not found")
}

func sortReposByCreated(all []*repo) {
	sortByCreatedSeq(all)
}

func sortStrings(in []string) { sort.Strings(in) }
