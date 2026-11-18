// Issue and pull-request records, their JSON shapes, and merge logic.
// Written fresh in Go for the v6 native core; behaviour mirrors the
// Node forge (app.ts) that passed 120/120 conformance.
package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

func (s *forgeState) createIssue(r *repo, title, body string, labels []string) *issue {
	r.mu.Lock()
	defer r.mu.Unlock()
	number := r.nextNum
	r.nextNum++
	now := isoNow()
	iss := &issue{
		id:        number,
		number:    number,
		title:     title,
		body:      body,
		state:     "open",
		labels:    labels,
		seq:       s.nextSeq(),
		createdAt: now,
		updatedAt: now,
	}
	iss.json = []byte(issueJSONString(r, iss))
	r.issues[number] = iss
	return iss
}

// issueJSONString renders the fixed issue shape byte-identically to
// JSON.stringify(issueToJson(...)): same key order, same string escaping.
// Manual appends (no fmt.Sprintf) for the write hot path.
func issueJSONString(r *repo, iss *issue) string {
	var b strings.Builder
	b.Grow(256)
	b.WriteString(`{"id":`)
	b.WriteString(strconv.Itoa(iss.id))
	b.WriteString(`,"number":`)
	b.WriteString(strconv.Itoa(iss.number))
	b.WriteString(`,"title":`)
	b.WriteString(jsonString(iss.title))
	b.WriteString(`,"body":`)
	b.WriteString(jsonString(iss.body))
	b.WriteString(`,"state":`)
	b.WriteString(jsonString(iss.state))
	b.WriteString(`,"labels":[`)
	for i, l := range iss.labels {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"name":`)
		b.WriteString(jsonString(l))
		b.WriteByte('}')
	}
	b.WriteString(`],"user":{"login":`)
	b.WriteString(jsonString(viewerLogin))
	b.WriteString(`,"id":`)
	b.WriteString(strconv.Itoa(viewerID))
	b.WriteString(`},"created_at":`)
	b.WriteString(jsonString(iss.createdAt))
	b.WriteString(`,"updated_at":`)
	b.WriteString(jsonString(iss.updatedAt))
	b.WriteString(`,"html_url":`)
	b.WriteString(jsonString("https://example.invalid/" + r.owner + "/" + r.name + "/issues/" + strconv.Itoa(iss.number)))
	b.WriteByte('}')
	return b.String()
}

// issueToJSON builds the issue object for non-hot paths (lists, MCP).
func issueToJSON(r *repo, iss *issue) map[string]any {
	labels := make([]map[string]string, len(iss.labels))
	for i, l := range iss.labels {
		labels[i] = map[string]string{"name": l}
	}
	return map[string]any{
		"id":         iss.id,
		"number":     iss.number,
		"title":      iss.title,
		"body":       iss.body,
		"state":      iss.state,
		"labels":     labels,
		"user":       map[string]any{"login": viewerLogin, "id": viewerID},
		"created_at": iss.createdAt,
		"updated_at": iss.updatedAt,
		"html_url":   fmt.Sprintf("https://example.invalid/%s/%s/issues/%d", r.owner, r.name, iss.number),
	}
}

func (s *forgeState) createPull(r *repo, title, body, head, base string) (*pull, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	headRef := "refs/heads/" + head
	baseRef := "refs/heads/" + base
	headSha, ok1 := r.refs[headRef]
	baseSha, ok2 := r.refs[baseRef]
	if !ok1 || !ok2 {
		return nil, "head or base branch not found"
	}
	for _, p := range r.pulls {
		if p.state == "open" && p.head == head {
			return nil, "a pull request already exists for this head branch"
		}
	}
	number := r.nextNum
	r.nextNum++
	now := isoNow()
	p := &pull{
		id:        number,
		number:    number,
		title:     title,
		body:      body,
		state:     "open",
		head:      head,
		base:      base,
		headSha:   headSha,
		baseSha:   baseSha,
		merged:    false,
		mergedAt:  "",
		seq:       s.nextSeq(),
		createdAt: now,
	}
	r.pulls[number] = p
	return p, ""
}

func pullToJSON(r *repo, p *pull) map[string]any {
	var mergedAt any = nil
	if p.mergedAt != "" {
		mergedAt = p.mergedAt
	}
	var mergeSha any = nil
	if p.mergeCommitSha != "" {
		mergeSha = p.mergeCommitSha
	}
	return map[string]any{
		"id":               p.id,
		"number":           p.number,
		"title":            p.title,
		"body":             p.body,
		"state":            p.state,
		"head":             map[string]any{"ref": p.head, "sha": p.headSha},
		"base":             map[string]any{"ref": p.base, "sha": p.baseSha},
		"merged":           p.merged,
		"merged_at":        mergedAt,
		"merge_commit_sha": mergeSha,
		"user":             map[string]any{"login": viewerLogin, "id": viewerID},
		"created_at":       p.createdAt,
	}
}

// pullMergeable is the three-way tree comparison via the merge base.
func (r *repo) pullMergeable(p *pull) string {
	if p.merged {
		return "UNKNOWN"
	}
	baseSha, ok := r.refs["refs/heads/"+p.base]
	if !ok {
		baseSha = p.baseSha
	}
	baseCommit := r.objects[baseSha]
	headCommit := r.objects[p.headSha]
	if baseCommit == nil || headCommit == nil || baseCommit.typ != "commit" || headCommit.typ != "commit" {
		return "UNKNOWN"
	}
	baseParts, ok1 := r.commitParts(baseSha)
	headParts, ok2 := r.commitParts(p.headSha)
	if !ok1 || !ok2 {
		return "UNKNOWN"
	}
	mergeBase, ok := r.findMergeBase(baseSha, p.headSha)
	if !ok {
		return "CONFLICTING"
	}
	baseTree := map[string]treeEntry{}
	headTree := map[string]treeEntry{}
	mergeTree := map[string]treeEntry{}
	if mergeObj := r.objects[mergeBase]; mergeObj != nil && mergeObj.typ == "commit" {
		if mergeParts, ok := r.commitParts(mergeBase); ok {
			r.flattenTree(mergeParts.tree, "", mergeTree)
		}
	}
	r.flattenTree(baseParts.tree, "", baseTree)
	r.flattenTree(headParts.tree, "", headTree)
	paths := map[string]bool{}
	for k := range mergeTree {
		paths[k] = true
	}
	for k := range baseTree {
		paths[k] = true
	}
	for k := range headTree {
		paths[k] = true
	}
	for path := range paths {
		m, hasM := mergeTree[path]
		b, hasB := baseTree[path]
		h, hasH := headTree[path]
		var mergeVal, baseVal, headVal string
		if hasM {
			mergeVal = m.oid
		}
		if hasB {
			baseVal = b.oid
		}
		if hasH {
			headVal = h.oid
		}
		baseChanged := baseVal != mergeVal
		headChanged := headVal != mergeVal
		if baseChanged && headChanged && baseVal != headVal {
			return "CONFLICTING"
		}
	}
	return "MERGEABLE"
}

// squashMergePull squash-merges a pull: returns the new merge commit oid
// or "" on conflict.
func (r *repo) squashMergePull(p *pull, message string) string {
	if r.pullMergeable(p) != "MERGEABLE" {
		return ""
	}
	headCommit := r.objects[p.headSha]
	if headCommit == nil || headCommit.typ != "commit" {
		return ""
	}
	headParts := parseCommit(headCommit.data)
	baseSha, ok := r.refs["refs/heads/"+p.base]
	if !ok {
		baseSha = p.baseSha
	}
	if message == "" {
		message = fmt.Sprintf("%s (#%d)", p.title, p.number)
	}
	mergeCommit := r.createCommit(headParts.tree, []string{baseSha}, message)
	r.refs["refs/heads/"+p.base] = mergeCommit
	p.merged = true
	p.mergedAt = isoNow()
	p.mergeCommitSha = mergeCommit
	p.state = "closed"
	r.invalidateCache()
	return mergeCommit
}

func repoToJSON(r *repo) map[string]any {
	return map[string]any{
		"id":             r.id,
		"name":           r.name,
		"full_name":      repoFullName(r),
		"owner":          map[string]any{"login": r.owner, "id": viewerID},
		"description":    r.description,
		"private":        r.priv,
		"default_branch": r.defaultBranch,
		"html_url":       fmt.Sprintf("https://example.invalid/%s/%s", r.owner, r.name),
		"created_at":     isoNow(),
	}
}

// sortedIssues returns issues sorted by seq; desc reverses.
func (r *repo) sortedIssues(desc bool) []*issue {
	list := make([]*issue, 0, len(r.issues))
	for _, iss := range r.issues {
		list = append(list, iss)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].seq < list[j].seq })
	if desc {
		for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
			list[i], list[j] = list[j], list[i]
		}
	}
	return list
}

func (r *repo) sortedPulls(desc bool) []*pull {
	list := make([]*pull, 0, len(r.pulls))
	for _, p := range r.pulls {
		list = append(list, p)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].seq < list[j].seq })
	if desc {
		for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
			list[i], list[j] = list[j], list[i]
		}
	}
	return list
}
