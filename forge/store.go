// In-memory store: forge state, repositories, issues, pulls, and the
// git-object graph operations (tree walks, ancestry, diffs).
// Written fresh in Go for the v6 native core; behaviour mirrors the
// Node forge (app.ts) that passed 120/120 conformance.
package main

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

type issue struct {
	id        int
	number    int
	title     string
	body      string
	state     string // "open" | "closed"
	labels    []string
	seq       int
	createdAt string
	updatedAt string
	json      []byte // pre-built response bytes (issueJsonString)
}

type pull struct {
	id             int
	number         int
	title          string
	body           string
	state          string // "open" | "closed"
	head           string
	base           string
	headSha        string
	baseSha        string
	merged         bool
	mergedAt       string
	mergeCommitSha string
	seq            int
	createdAt      string
}

type comment struct {
	id        int
	body      string
	user      string
	createdAt string
}

type label struct {
	name  string
	color string
}

type repo struct {
	id            int
	name          string
	owner         string
	description   string
	priv          bool
	defaultBranch string
	createdSeq    int

	mu       sync.RWMutex
	objects  map[string]*gitObject
	refs     map[string]string
	issues   map[int]*issue
	pulls    map[int]*pull
	nextNum  int
	labels   map[string]*label
	comments map[int][]*comment

	packCache   sync.Map // string -> []byte
	advCache    sync.Map // service -> []byte
	commitCache sync.Map // oid -> commitParts
	treeCache   sync.Map // oid -> []treeEntry
	treeByName  sync.Map // tree oid -> map[string]treeEntry
}

type forgeState struct {
	token         string
	authHeader    string
	mu            sync.RWMutex
	repos         map[string]*repo
	nextRepoID    int
	nextCommentID int
	requestSeq    atomic.Uint64 // lock-free request-id counter (hot path)
	globalSeq     int
	seqMu         sync.Mutex // guards globalSeq only (never held with repo locks)
}

func newForgeState(token string) *forgeState {
	return &forgeState{
		token:         token,
		authHeader:    "Bearer " + token,
		repos:         make(map[string]*repo),
		nextRepoID:    1,
		nextCommentID: 1,
	}
}

func (s *forgeState) nextSeq() int {
	s.seqMu.Lock()
	defer s.seqMu.Unlock()
	s.globalSeq++
	return s.globalSeq
}

func repoKey(owner, name string) string { return owner + "/" + name }

func (s *forgeState) getRepo(owner, name string) *repo {
	if owner != viewerLogin {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.repos[repoKey(owner, name)]
}

func (s *forgeState) createRepo(name, description string, priv bool) *repo {
	r := &repo{
		name:          name,
		owner:         viewerLogin,
		description:   description,
		priv:          priv,
		defaultBranch: defBranch,
		objects:       make(map[string]*gitObject),
		refs:          make(map[string]string),
		issues:        make(map[int]*issue),
		pulls:         make(map[int]*pull),
		nextNum:       1,
		labels:        make(map[string]*label),
		comments:      make(map[int][]*comment),
	}
	s.mu.Lock()
	r.id = s.nextRepoID
	s.nextRepoID++
	s.globalSeq++
	r.createdSeq = s.globalSeq
	s.repos[repoKey(viewerLogin, name)] = r
	s.mu.Unlock()
	return r
}

func repoFullName(r *repo) string { return r.owner + "/" + r.name }

func globalID(kind string, dbID int) string { return b64encode(fmt.Sprintf("%s:%d", kind, dbID)) }

func defaultBranchRefName(r *repo) string { return "refs/heads/" + r.defaultBranch }

func resolveRef(r *repo, refname string) (string, bool) {
	if refname == "HEAD" {
		oid, ok := r.refs[defaultBranchRefName(r)]
		return oid, ok
	}
	oid, ok := r.refs[refname]
	return oid, ok
}

func peelToCommit(r *repo, oid string) (string, bool) {
	cur := oid
	seen := map[string]bool{}
	for i := 0; i < 10; i++ {
		if seen[cur] {
			return "", false
		}
		seen[cur] = true
		obj := r.objects[cur]
		if obj == nil {
			return "", false
		}
		if obj.typ == "commit" {
			return cur, true
		}
		if obj.typ == "tag" {
			cur = parseTag(obj.data).object
			continue
		}
		return "", false
	}
	return "", false
}

func (r *repo) storeObject(typ string, data []byte) string {
	oid := hashObject(typ, data)
	if _, ok := r.objects[oid]; !ok {
		r.objects[oid] = &gitObject{typ: typ, data: data}
	}
	return oid
}

func (r *repo) createCommit(tree string, parents []string, message string) string {
	return r.storeObject("commit", buildCommit(tree, parents, message))
}

func (r *repo) invalidateCache() {
	r.packCache.Range(func(k, v any) bool { r.packCache.Delete(k); return true })
	r.advCache.Range(func(k, v any) bool { r.advCache.Delete(k); return true })
}

// treeEntriesOf returns parsed entries for a tree object, cached.
func (r *repo) treeEntriesOf(oid string) []treeEntry {
	if cached, ok := r.treeCache.Load(oid); ok {
		return cached.([]treeEntry)
	}
	obj := r.objects[oid]
	if obj == nil || obj.typ != "tree" {
		return nil
	}
	entries, err := parseTree(obj.data)
	if err != nil {
		return nil
	}
	actual, _ := r.treeCache.LoadOrStore(oid, entries)
	return actual.([]treeEntry)
}

func (r *repo) treeEntryByName(treeOID, name string) (treeEntry, bool) {
	cached, ok := r.treeByName.Load(treeOID)
	if !ok {
		byName := make(map[string]treeEntry)
		for _, e := range r.treeEntriesOf(treeOID) {
			byName[e.name] = e
		}
		actual, _ := r.treeByName.LoadOrStore(treeOID, byName)
		cached = actual
	}
	e, ok := cached.(map[string]treeEntry)[name]
	return e, ok
}

// commitParts returns parsed headers for a commit, cached.
func (r *repo) commitParts(oid string) (commitParts, bool) {
	if cached, ok := r.commitCache.Load(oid); ok {
		return cached.(commitParts), true
	}
	obj := r.objects[oid]
	if obj == nil || obj.typ != "commit" {
		return commitParts{}, false
	}
	parts := parseCommit(obj.data)
	actual, _ := r.commitCache.LoadOrStore(oid, parts)
	return actual.(commitParts), true
}

func (r *repo) flattenTree(treeOID, prefix string, out map[string]treeEntry) {
	for _, e := range r.treeEntriesOf(treeOID) {
		path := e.name
		if prefix != "" {
			path = prefix + "/" + e.name
		}
		if e.mode == "40000" {
			r.flattenTree(e.oid, path, out)
		} else {
			out[path] = e
		}
	}
}

func (r *repo) lookupPath(treeOID string, segments []string) (treeEntry, bool) {
	cur := treeOID
	for i, seg := range segments {
		obj := r.objects[cur]
		if obj == nil || obj.typ != "tree" {
			return treeEntry{}, false
		}
		e, ok := r.treeEntryByName(cur, seg)
		if !ok {
			return treeEntry{}, false
		}
		if i == len(segments)-1 {
			return e, true
		}
		if e.mode != "40000" {
			return treeEntry{}, false
		}
		cur = e.oid
	}
	return treeEntry{}, false
}

func (r *repo) readBlobText(oid string) (string, bool) {
	obj := r.objects[oid]
	if obj == nil || obj.typ != "blob" {
		return "", false
	}
	return string(obj.data), true
}

func (r *repo) buildTreeWithPath(baseTreeOID string, hasBase bool, segments []string, blobOID, blobMode string) string {
	if len(segments) == 0 {
		if hasBase {
			return baseTreeOID
		}
		return r.storeObject("tree", buildTree(nil))
	}
	head := segments[0]
	rest := segments[1:]
	var entries []treeEntry
	if hasBase {
		entries = r.treeEntriesOf(baseTreeOID)
	}
	next := make([]treeEntry, 0, len(entries)+1)
	found := false
	for _, e := range entries {
		if e.name != head {
			next = append(next, e)
			continue
		}
		found = true
		if len(rest) == 0 {
			next = append(next, treeEntry{mode: blobMode, name: head, oid: blobOID})
		} else if e.mode == "40000" {
			next = append(next, treeEntry{mode: "40000", name: head, oid: r.buildTreeWithPath(e.oid, true, rest, blobOID, blobMode)})
		} else {
			next = append(next, treeEntry{mode: "40000", name: head, oid: r.buildTreeWithPath("", false, rest, blobOID, blobMode)})
		}
	}
	if !found {
		if len(rest) == 0 {
			next = append(next, treeEntry{mode: blobMode, name: head, oid: blobOID})
		} else {
			next = append(next, treeEntry{mode: "40000", name: head, oid: r.buildTreeWithPath("", false, rest, blobOID, blobMode)})
		}
	}
	return r.storeObject("tree", buildTree(next))
}

func (r *repo) buildTreeWithoutPath(baseTreeOID string, segments []string) (string, bool) {
	head := segments[0]
	rest := segments[1:]
	entries := r.treeEntriesOf(baseTreeOID)
	next := make([]treeEntry, 0, len(entries))
	found := false
	for _, e := range entries {
		if e.name != head {
			next = append(next, e)
			continue
		}
		found = true
		if len(rest) == 0 {
			continue // drop it
		}
		if e.mode != "40000" {
			continue
		}
		child, ok := r.buildTreeWithoutPath(e.oid, rest)
		if ok {
			next = append(next, treeEntry{mode: "40000", name: head, oid: child})
		}
	}
	if !found {
		return baseTreeOID, true
	}
	if len(next) == 0 {
		return "", false
	}
	return r.storeObject("tree", buildTree(next)), true
}

type chainEntry struct {
	oid    string
	commit commitParts
}

// commitChain is the first-parent chain from a tip, newest first.
func (r *repo) commitChain(tipOID string, limit int) []chainEntry {
	var out []chainEntry
	cur := tipOID
	seen := map[string]bool{}
	for cur != "" && len(out) < limit && !seen[cur] {
		seen[cur] = true
		parts, ok := r.commitParts(cur)
		if !ok {
			break
		}
		out = append(out, chainEntry{oid: cur, commit: parts})
		if len(parts.parents) == 0 {
			break
		}
		cur = parts.parents[0]
	}
	return out
}

func (r *repo) isAncestor(anc, desc string) bool {
	if anc == desc {
		return true
	}
	// Fast path: linear first-parent chain.
	cur := desc
	seenFirst := map[string]bool{}
	for cur != "" && !seenFirst[cur] {
		seenFirst[cur] = true
		parts, ok := r.commitParts(cur)
		if !ok || len(parts.parents) == 0 {
			break
		}
		first := parts.parents[0]
		if first == anc {
			return true
		}
		cur = first
		if len(seenFirst) > 100000 {
			break
		}
	}
	// General DAG: BFS with an index-pointer queue.
	queue := []string{desc}
	seen := map[string]bool{desc: true}
	head := 0
	for head < len(queue) {
		curOID := queue[head]
		head++
		parts, ok := r.commitParts(curOID)
		if !ok {
			continue
		}
		for _, p := range parts.parents {
			if p == anc {
				return true
			}
			if !seen[p] {
				seen[p] = true
				queue = append(queue, p)
			}
		}
		if len(seen) > 100000 {
			return false
		}
	}
	return false
}

func (r *repo) findMergeBase(a, b string) (string, bool) {
	ancestors := map[string]bool{}
	queueA := []string{a}
	seenA := map[string]bool{a: true}
	headA := 0
	for headA < len(queueA) {
		cur := queueA[headA]
		headA++
		ancestors[cur] = true
		parts, ok := r.commitParts(cur)
		if !ok {
			continue
		}
		for _, p := range parts.parents {
			if !seenA[p] {
				seenA[p] = true
				queueA = append(queueA, p)
			}
		}
		if len(ancestors) > 100000 {
			break
		}
	}
	queueB := []string{b}
	seenB := map[string]bool{b: true}
	headB := 0
	for headB < len(queueB) {
		cur := queueB[headB]
		headB++
		if ancestors[cur] {
			return cur, true
		}
		parts, ok := r.commitParts(cur)
		if !ok {
			continue
		}
		for _, p := range parts.parents {
			if !seenB[p] {
				seenB[p] = true
				queueB = append(queueB, p)
			}
		}
		if len(seenB) > 100000 {
			break
		}
	}
	return "", false
}

// ------------------------------------------------------------ line diff

func countLines(text string) int {
	if len(text) == 0 {
		return 0
	}
	n := strings.Count(text, "\n")
	if strings.HasSuffix(text, "\n") {
		return n
	}
	return n + 1
}

type lineDiff struct{ additions, deletions int }

// diffLines is an LCS-based line diff (DP capped; falls back to full
// counts for big files).
func diffLines(baseText, headText string) lineDiff {
	var a, b []string
	if len(baseText) > 0 {
		a = strings.Split(baseText, "\n")
	}
	if len(headText) > 0 {
		b = strings.Split(headText, "\n")
	}
	if len(a) > 0 && a[len(a)-1] == "" {
		a = a[:len(a)-1]
	}
	if len(b) > 0 && b[len(b)-1] == "" {
		b = b[:len(b)-1]
	}
	if len(a) > 400 || len(b) > 400 {
		return lineDiff{additions: len(b), deletions: len(a)}
	}
	dp := make([][]int, len(a)+1)
	for i := range dp {
		dp[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] > dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}
	lcs := dp[0][0]
	return lineDiff{additions: len(b) - lcs, deletions: len(a) - lcs}
}

type fileDiff struct {
	filename  string
	status    string // "added" | "modified" | "removed" | "changed"
	additions int
	deletions int
	changes   int
}

func (r *repo) diffTrees(baseTreeOID, headTreeOID string, hasBase, hasHead bool) []fileDiff {
	baseMap := map[string]treeEntry{}
	headMap := map[string]treeEntry{}
	if hasBase {
		r.flattenTree(baseTreeOID, "", baseMap)
	}
	if hasHead {
		r.flattenTree(headTreeOID, "", headMap)
	}
	paths := map[string]bool{}
	for p := range baseMap {
		paths[p] = true
	}
	for p := range headMap {
		paths[p] = true
	}
	sorted := make([]string, 0, len(paths))
	for p := range paths {
		sorted = append(sorted, p)
	}
	sort.Strings(sorted)
	var out []fileDiff
	for _, path := range sorted {
		b, hasB := baseMap[path]
		h, hasH := headMap[path]
		if hasB && !hasH {
			text, _ := r.readBlobText(b.oid)
			d := countLines(text)
			out = append(out, fileDiff{filename: path, status: "removed", deletions: d, changes: d})
		} else if !hasB && hasH {
			text, _ := r.readBlobText(h.oid)
			a := countLines(text)
			out = append(out, fileDiff{filename: path, status: "added", additions: a, changes: a})
		} else if hasB && hasH && b.oid != h.oid {
			bt, _ := r.readBlobText(b.oid)
			ht, _ := r.readBlobText(h.oid)
			d := diffLines(bt, ht)
			out = append(out, fileDiff{filename: path, status: "modified", additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions})
		}
	}
	return out
}
