// REST v3, continued: contents, issues, pulls.
// Written fresh in Go for the v6 native core; behaviour mirrors the
// Node forge (app.ts) that passed 120/120 conformance.
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

func unmarshalJSON(b []byte, v any) error { return json.Unmarshal(b, v) }

func sortByCreatedSeq(all []*repo) {
	sort.Slice(all, func(i, j int) bool { return all[i].createdSeq < all[j].createdSeq })
}

func b64decodeBytes(s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return []byte{}
	}
	return b
}

// handleContents serves /repos/:owner/:repo/contents/:path.
func handleContents(s *forgeState, r *repo, pathSegs []string, method string, query map[string]string, req *httpRequest) httpResponse {
	if len(pathSegs) == 0 {
		return errJSON(404, "not found")
	}
	path := strings.Join(pathSegs, "/")
	r.mu.RLock()
	tip, hasTip := resolveRef(r, "HEAD")
	r.mu.RUnlock()
	if method == "GET" {
		refName := query["ref"]
		if refName == "" {
			refName = r.defaultBranch
		}
		r.mu.RLock()
		refOID, ok := resolveRef(r, "refs/heads/"+refName)
		if !ok && isOID(refName) {
			refOID, ok = refName, true
		}
		if !ok {
			r.mu.RUnlock()
			return errJSON(404, "ref not found")
		}
		commit := r.objects[refOID]
		if commit == nil || commit.typ != "commit" {
			r.mu.RUnlock()
			return errJSON(404, "ref not found")
		}
		treeOID := parseCommit(commit.data).tree
		found, ok := r.lookupPath(treeOID, pathSegs)
		if !ok {
			r.mu.RUnlock()
			return errJSON(404, "not found")
		}
		if found.mode == "40000" {
			entries := r.treeEntriesOf(found.oid)
			out := make([]map[string]any, 0, len(entries))
			for _, e := range entries {
				size := 0
				if e.mode != "40000" {
					if obj := r.objects[e.oid]; obj != nil {
						size = len(obj.data)
					}
				}
				typ := "file"
				if e.mode == "40000" {
					typ = "dir"
				}
				out = append(out, map[string]any{
					"name": e.name,
					"path": path + "/" + e.name,
					"sha":  e.oid,
					"type": typ,
					"size": size,
				})
			}
			r.mu.RUnlock()
			return jsonResp(200, out, nil)
		}
		obj := r.objects[found.oid]
		var data []byte
		if obj != nil {
			data = obj.data
		}
		resp := map[string]any{
			"name":     pathSegs[len(pathSegs)-1],
			"path":     path,
			"sha":      found.oid,
			"size":     len(data),
			"type":     "file",
			"encoding": "base64",
			"content":  base64.StdEncoding.EncodeToString(data),
		}
		r.mu.RUnlock()
		return jsonResp(200, resp, nil)
	}
	if method == "PUT" {
		parsed, ok := parseJSONBody(req.body)
		if !ok {
			return errJSON(400, "invalid JSON body")
		}
		body := bodyMap(parsed)
		contentB64, _ := body["content"].(string)
		message, _ := body["message"].(string)
		if message == "" {
			message = "update file"
		}
		sha, _ := body["sha"].(string)
		branch, _ := body["branch"].(string)
		if branch == "" {
			branch = r.defaultBranch
		}
		targetRef := "refs/heads/" + branch
		r.mu.Lock()
		defer r.mu.Unlock()
		tip, hasTip := r.refs[targetRef]
		if !hasTip {
			blobOID := r.storeObject("blob", b64decodeBytes(contentB64))
			treeOID := r.buildTreeWithPath("", false, pathSegs, blobOID, "100644")
			commitOID := r.createCommit(treeOID, nil, message)
			r.refs[targetRef] = commitOID
			r.invalidateCache()
			return jsonResp(201, map[string]any{
				"content": map[string]any{"name": pathSegs[len(pathSegs)-1], "path": path, "sha": blobOID, "size": len(b64decodeBytes(contentB64)), "encoding": "base64"},
				"commit":  map[string]any{"sha": commitOID, "message": message},
			}, nil)
		}
		tipCommit := r.objects[tip]
		if tipCommit == nil || tipCommit.typ != "commit" {
			return errJSON(404, "not found")
		}
		tipParts := parseCommit(tipCommit.data)
		existing, hasExisting := r.lookupPath(tipParts.tree, pathSegs)
		if sha != "" && hasExisting && existing.oid != sha {
			return errJSON(409, "sha mismatch")
		}
		if sha != "" && !hasExisting {
			return errJSON(409, "sha mismatch")
		}
		blobData := b64decodeBytes(contentB64)
		blobOID := r.storeObject("blob", blobData)
		treeOID := r.buildTreeWithPath(tipParts.tree, true, pathSegs, blobOID, "100644")
		commitOID := r.createCommit(treeOID, []string{tip}, message)
		r.refs[targetRef] = commitOID
		r.invalidateCache()
		status := 201
		if hasExisting {
			status = 200
		}
		return jsonResp(status, map[string]any{
			"content": map[string]any{"name": pathSegs[len(pathSegs)-1], "path": path, "sha": blobOID, "size": len(blobData), "encoding": "base64"},
			"commit":  map[string]any{"sha": commitOID, "message": message},
		}, nil)
	}
	if method == "DELETE" {
		parsed, ok := parseJSONBody(req.body)
		if !ok {
			return errJSON(400, "invalid JSON body")
		}
		body := bodyMap(parsed)
		message, _ := body["message"].(string)
		if message == "" {
			message = "delete file"
		}
		sha, _ := body["sha"].(string)
		if !hasTip {
			return errJSON(404, "not found")
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		tipCommit := r.objects[tip]
		if tipCommit == nil || tipCommit.typ != "commit" {
			return errJSON(404, "not found")
		}
		tipParts := parseCommit(tipCommit.data)
		existing, hasExisting := r.lookupPath(tipParts.tree, pathSegs)
		if !hasExisting {
			return errJSON(404, "not found")
		}
		if sha != "" && existing.oid != sha {
			return errJSON(409, "sha mismatch")
		}
		newTree, ok := r.buildTreeWithoutPath(tipParts.tree, pathSegs)
		if !ok {
			newTree = r.storeObject("tree", buildTree(nil))
		}
		commitOID := r.createCommit(newTree, []string{tip}, message)
		r.refs[defaultBranchRefName(r)] = commitOID
		r.invalidateCache()
		return jsonResp(200, map[string]any{"commit": map[string]any{"sha": commitOID, "message": message}}, nil)
	}
	return errJSON(404, "not found")
}

// handleIssues serves /repos/:owner/:repo/issues[/:number[/comments]].
func handleIssues(s *forgeState, r *repo, sub []string, method string, query map[string]string, req *httpRequest) httpResponse {
	if len(sub) == 0 {
		if method == "GET" {
			stateFilter := query["state"]
			if stateFilter == "" {
				stateFilter = "open"
			}
			sortMode := query["sort"]
			if sortMode == "" {
				sortMode = "created"
			}
			direction := query["direction"]
			if direction == "" {
				direction = "desc"
			}
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
			r.mu.RLock()
			list := r.sortedIssues(direction != "asc")
			if stateFilter != "all" {
				filtered := list[:0]
				for _, iss := range list {
					if iss.state == stateFilter {
						filtered = append(filtered, iss)
					}
				}
				list = filtered
			}
			start := (page - 1) * perPage
			end := start + perPage
			if start > len(list) {
				start = len(list)
			}
			if end > len(list) {
				end = len(list)
			}
			slice := list[start:end]
			out := make([]map[string]any, len(slice))
			for i, iss := range slice {
				out[i] = issueToJSON(r, iss)
			}
			r.mu.RUnlock()
			_ = sortMode
			return jsonResp(200, out, nil)
		}
		if method == "POST" {
			title, bodyText, labels, ok := fastIssueFields(req.body)
			if !ok {
				return errJSON(400, "invalid JSON body")
			}
			if title == "" {
				return errJSON(422, "title is required")
			}
			r.mu.RLock()
			for _, l := range labels {
				if _, has := r.labels[l]; !has {
					r.mu.RUnlock()
					return errJSON(422, fmt.Sprintf("label %s does not exist", l))
				}
			}
			r.mu.RUnlock()
			iss := s.createIssue(r, title, bodyText, labels)
			return jsonRespRaw(201, iss.json)
		}
		return errJSON(404, "not found")
	}
	num, err := strconv.Atoi(sub[0])
	if err != nil {
		return errJSON(404, "not found")
	}
	r.mu.RLock()
	iss, ok := r.issues[num]
	r.mu.RUnlock()
	if !ok {
		return errJSON(404, "not found")
	}
	if len(sub) == 1 {
		if method == "GET" {
			r.mu.RLock()
			bodyBytes := iss.json
			r.mu.RUnlock()
			return jsonRespRaw(200, bodyBytes)
		}
		if method == "PATCH" {
			parsed, ok := parseJSONBody(req.body)
			if !ok {
				return errJSON(400, "invalid JSON body")
			}
			body := bodyMap(parsed)
			r.mu.Lock()
			if t, isStr := body["title"].(string); isStr {
				iss.title = t
			}
			if b, isStr := body["body"].(string); isStr {
				iss.body = b
			}
			if st, isStr := body["state"].(string); isStr && (st == "open" || st == "closed") {
				iss.state = st
			}
			iss.updatedAt = isoNow()
			iss.json = []byte(issueJSONString(r, iss))
			bodyBytes := iss.json
			r.mu.Unlock()
			return jsonRespRaw(200, bodyBytes)
		}
		return errJSON(404, "not found")
	}
	if len(sub) == 2 && sub[1] == "comments" {
		if method == "GET" {
			r.mu.RLock()
			list := r.comments[num]
			out := make([]map[string]any, 0, len(list))
			for _, c := range list {
				out = append(out, map[string]any{
					"id":         c.id,
					"body":       c.body,
					"user":       map[string]any{"login": c.user, "id": viewerID},
					"created_at": c.createdAt,
				})
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
			text, _ := body["body"].(string)
			s.mu.Lock()
			cid := s.nextCommentID
			s.nextCommentID++
			s.mu.Unlock()
			c := &comment{id: cid, body: text, user: viewerLogin, createdAt: isoNow()}
			r.mu.Lock()
			r.comments[num] = append(r.comments[num], c)
			r.mu.Unlock()
			return jsonResp(201, map[string]any{
				"id":         c.id,
				"body":       c.body,
				"user":       map[string]any{"login": c.user, "id": viewerID},
				"created_at": c.createdAt,
			}, nil)
		}
		return errJSON(404, "not found")
	}
	return errJSON(404, "not found")
}

// handlePulls serves /repos/:owner/:repo/pulls[/:number[/files|/merge]].
func handlePulls(s *forgeState, r *repo, sub []string, method string, query map[string]string, req *httpRequest) httpResponse {
	if len(sub) == 0 {
		if method == "GET" {
			stateFilter := query["state"]
			if stateFilter == "" {
				stateFilter = "open"
			}
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
			r.mu.RLock()
			list := r.sortedPulls(true)
			if stateFilter != "all" {
				filtered := list[:0]
				for _, p := range list {
					if p.state == stateFilter {
						filtered = append(filtered, p)
					}
				}
				list = filtered
			}
			start := (page - 1) * perPage
			end := start + perPage
			if start > len(list) {
				start = len(list)
			}
			if end > len(list) {
				end = len(list)
			}
			slice := list[start:end]
			out := make([]map[string]any, len(slice))
			for i, p := range slice {
				out[i] = pullToJSON(r, p)
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
			title, _ := body["title"].(string)
			head, _ := body["head"].(string)
			base, _ := body["base"].(string)
			if title == "" || head == "" || base == "" {
				return errJSON(422, "title, head and base are required")
			}
			bodyText, _ := body["body"].(string)
			p, errStr := s.createPull(r, title, bodyText, head, base)
			if errStr != "" {
				return errJSON(422, errStr)
			}
			return jsonResp(201, pullToJSON(r, p), nil)
		}
		return errJSON(404, "not found")
	}
	num, err := strconv.Atoi(sub[0])
	if err != nil {
		return errJSON(404, "not found")
	}
	r.mu.RLock()
	p, ok := r.pulls[num]
	r.mu.RUnlock()
	if !ok {
		return errJSON(404, "not found")
	}
	if len(sub) == 1 {
		if method != "GET" {
			return errJSON(404, "not found")
		}
		r.mu.RLock()
		j := pullToJSON(r, p)
		r.mu.RUnlock()
		return jsonResp(200, j, nil)
	}
	if len(sub) == 2 && sub[1] == "files" {
		if method != "GET" {
			return errJSON(404, "not found")
		}
		r.mu.RLock()
		var baseTree, headTree string
		var hasBase, hasHead bool
		if baseCommit := r.objects[p.baseSha]; baseCommit != nil && baseCommit.typ == "commit" {
			baseTree = parseCommit(baseCommit.data).tree
			hasBase = true
		}
		if headCommit := r.objects[p.headSha]; headCommit != nil && headCommit.typ == "commit" {
			headTree = parseCommit(headCommit.data).tree
			hasHead = true
		}
		files := r.diffTrees(baseTree, headTree, hasBase, hasHead)
		out := make([]map[string]any, len(files))
		for i, f := range files {
			out[i] = map[string]any{
				"filename":  f.filename,
				"status":    f.status,
				"additions": f.additions,
				"deletions": f.deletions,
				"changes":   f.changes,
			}
		}
		r.mu.RUnlock()
		return jsonResp(200, out, nil)
	}
	if len(sub) == 2 && sub[1] == "merge" {
		if method != "PUT" {
			return errJSON(404, "not found")
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		if p.merged {
			return jsonResp(200, map[string]any{"merged": true, "sha": p.mergeCommitSha, "message": "already merged"}, nil)
		}
		parsed, ok := parseJSONBody(req.body)
		if !ok {
			return errJSON(400, "invalid JSON body")
		}
		body := bodyMap(parsed)
		if r.pullMergeable(p) != "MERGEABLE" {
			return errJSON(405, "merge conflict")
		}
		commitMessage, _ := body["commit_message"].(string)
		mergeSha := r.squashMergePull(p, commitMessage)
		if mergeSha == "" {
			return errJSON(405, "merge conflict")
		}
		msg := commitMessage
		if msg == "" {
			msg = fmt.Sprintf("%s (#%d)", p.title, p.number)
		}
		return jsonResp(200, map[string]any{"merged": true, "sha": mergeSha, "message": msg}, nil)
	}
	return errJSON(404, "not found")
}
