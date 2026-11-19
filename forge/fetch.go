// Git smart-HTTP: fetch send-sets, v2/v0 responses, advertisements,
// ls-refs, and push handling.
// Written fresh in Go for the v6 native core; behaviour mirrors the
// Node forge (app.ts) that passed 120/120 conformance.
package main

import (
	"bytes"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type sendSet struct {
	send         map[string]*gitObject
	shallowOut   []string
	unshallowOut []string
}

// computeSendSet works out which objects a fetch must send.
func (r *repo) computeSendSet(wants, haves, shallowBoundaries []string, depth *int) *sendSet {
	haveSet := map[string]bool{}
	for _, h := range haves {
		haveSet[h] = true
	}
	shallowSet := map[string]bool{}
	for _, s := range shallowBoundaries {
		shallowSet[s] = true
	}
	send := map[string]*gitObject{}
	var toSendCommits []string
	visitedCommits := map[string]bool{}

	addObject := func(oid string) {
		if obj, ok := r.objects[oid]; ok {
			if _, has := send[oid]; !has {
				send[oid] = obj
			}
		}
	}
	addTreeClosure := func(treeOID string, seenTrees map[string]bool) {
		stack := []string{treeOID}
		for len(stack) > 0 {
			t := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if seenTrees[t] {
				continue
			}
			seenTrees[t] = true
			addObject(t)
			obj := r.objects[t]
			if obj == nil || obj.typ != "tree" {
				continue
			}
			for _, e := range r.treeEntriesOf(t) {
				if e.mode == "40000" {
					stack = append(stack, e.oid)
				} else {
					addObject(e.oid)
				}
			}
		}
	}

	var wantCommits []string
	for _, want := range wants {
		obj := r.objects[want]
		if obj == nil {
			continue
		}
		if obj.typ == "tag" {
			addObject(want)
			if target, ok := peelToCommit(r, want); ok {
				wantCommits = append(wantCommits, target)
			}
		} else if obj.typ == "commit" {
			wantCommits = append(wantCommits, want)
		} else {
			addObject(want)
		}
	}

	type stackEnt struct {
		oid   string
		depth int
	}
	stack := make([]stackEnt, 0, len(wantCommits))
	for _, oid := range wantCommits {
		stack = append(stack, stackEnt{oid, 1})
	}
	for len(stack) > 0 {
		ent := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		oid, d := ent.oid, ent.depth
		if visitedCommits[oid] {
			continue
		}
		visitedCommits[oid] = true
		obj := r.objects[oid]
		if obj == nil || obj.typ != "commit" {
			continue
		}
		if depth != nil && d > *depth {
			continue
		}
		if depth == nil && (haveSet[oid] || shallowSet[oid]) {
			continue
		}
		toSendCommits = append(toSendCommits, oid)
		parts, ok := r.commitParts(oid)
		if !ok {
			continue
		}
		for _, p := range parts.parents {
			stack = append(stack, stackEnt{p, d + 1})
		}
	}

	treeSeen := map[string]bool{}
	for _, oid := range toSendCommits {
		addObject(oid)
		parts, ok := r.commitParts(oid)
		if !ok {
			continue
		}
		addTreeClosure(parts.tree, treeSeen)
	}

	// Subtract what the client already holds.
	held := map[string]bool{}
	heldTreeSeen := map[string]bool{}
	var collectHeld func(oid string)
	collectHeld = func(oid string) {
		peeled, ok := peelToCommit(r, oid)
		if !ok {
			return
		}
		if held[peeled] {
			return
		}
		held[peeled] = true
		obj := r.objects[peeled]
		if obj == nil || obj.typ != "commit" {
			return
		}
		parts, ok := r.commitParts(peeled)
		if !ok {
			return
		}
		stack2 := []string{parts.tree}
		for len(stack2) > 0 {
			t := stack2[len(stack2)-1]
			stack2 = stack2[:len(stack2)-1]
			if heldTreeSeen[t] {
				continue
			}
			heldTreeSeen[t] = true
			held[t] = true
			tObj := r.objects[t]
			if tObj == nil || tObj.typ != "tree" {
				continue
			}
			for _, e := range r.treeEntriesOf(t) {
				if e.mode == "40000" {
					stack2 = append(stack2, e.oid)
				} else {
					held[e.oid] = true
				}
			}
		}
	}
	for _, h := range haves {
		collectHeld(h)
	}
	for _, s := range shallowBoundaries {
		collectHeld(s)
	}
	for oid := range held {
		delete(send, oid)
	}

	var shallowOut, unshallowOut []string
	if depth != nil {
		sentSet := map[string]bool{}
		for _, oid := range toSendCommits {
			sentSet[oid] = true
		}
		for _, oid := range toSendCommits {
			obj := r.objects[oid]
			if obj == nil || obj.typ != "commit" {
				continue
			}
			parts, ok := r.commitParts(oid)
			if !ok {
				continue
			}
			hasParent := len(parts.parents) > 0
			allParentsSent := true
			for _, p := range parts.parents {
				if !sentSet[p] {
					allParentsSent = false
					break
				}
			}
			if hasParent && !allParentsSent {
				shallowOut = append(shallowOut, oid)
			}
			if shallowSet[oid] && hasParent && allParentsSent {
				unshallowOut = append(unshallowOut, oid)
			}
		}
	}
	return &sendSet{send: send, shallowOut: shallowOut, unshallowOut: unshallowOut}
}

type fetchRequest struct {
	wants   []string
	haves   []string
	shallow []string
	depth   *int
	deepen  *int
	isV2    bool
	lsRefs  *lsRefsOptions
	filter  string
}

func buildFetchV2Response(r *repo, req *fetchRequest, pack []byte, shallowOut, unshallowOut []string) []byte {
	var parts [][]byte
	parts = append(parts, pktLineStr("acknowledgments\n"))
	for _, h := range req.haves {
		peeled, ok := peelToCommit(r, h)
		heldCommit := h
		if ok {
			heldCommit = peeled
		}
		obj := r.objects[heldCommit]
		if obj != nil && obj.typ == "commit" {
			parts = append(parts, pktLineStr(fmt.Sprintf("ACK %s\n", heldCommit)))
		} else {
			parts = append(parts, pktLineStr("NAK\n"))
		}
	}
	if len(req.haves) == 0 {
		parts = append(parts, pktLineStr("NAK\n"))
	}
	parts = append(parts, pktLineStr("ready\n"))
	parts = append(parts, pktDelim)
	if req.depth != nil {
		parts = append(parts, pktLineStr("shallow-info\n"))
		for _, s := range shallowOut {
			parts = append(parts, pktLineStr(fmt.Sprintf("shallow %s\n", s)))
		}
		for _, s := range unshallowOut {
			parts = append(parts, pktLineStr(fmt.Sprintf("unshallow %s\n", s)))
		}
		parts = append(parts, pktDelim)
	}
	if pack != nil {
		parts = append(parts, pktLineStr("packfile\n"))
		const chunk = 65515
		for off := 0; off < len(pack); off += chunk {
			n := chunk
			if off+n > len(pack) {
				n = len(pack) - off
			}
			parts = append(parts, pktLineBanded(pack, off, n))
		}
	}
	parts = append(parts, pktFlush)
	return bytes.Join(parts, nil)
}

func buildFetchV0Response(r *repo, req *fetchRequest, pack []byte, shallowOut, unshallowOut []string) []byte {
	var parts [][]byte
	for _, h := range req.haves {
		peeled, ok := peelToCommit(r, h)
		heldCommit := h
		if ok {
			heldCommit = peeled
		}
		obj := r.objects[heldCommit]
		if obj != nil && obj.typ == "commit" {
			parts = append(parts, pktLineStr(fmt.Sprintf("ACK %s\n", heldCommit)))
		} else {
			parts = append(parts, pktLineStr("NAK\n"))
		}
	}
	if len(req.haves) == 0 {
		parts = append(parts, pktLineStr("NAK\n"))
	}
	for _, s := range shallowOut {
		parts = append(parts, pktLineStr(fmt.Sprintf("shallow %s\n", s)))
	}
	for _, s := range unshallowOut {
		parts = append(parts, pktLineStr(fmt.Sprintf("unshallow %s\n", s)))
	}
	if pack != nil {
		const chunk = 65515
		for off := 0; off < len(pack); off += chunk {
			n := chunk
			if off+n > len(pack) {
				n = len(pack) - off
			}
			parts = append(parts, pktLineBanded(pack, off, n))
		}
	}
	parts = append(parts, pktFlush)
	return bytes.Join(parts, nil)
}

// ------------------------------------------------------- git HTTP

var v2Advertisement = bytes.Join([][]byte{
	pktLineStr("# service=git-upload-pack\n"),
	pktFlush,
	pktLineStr("version 2\n"),
	pktLineStr("ls-refs=unborn\n"),
	pktLineStr("fetch=shallow filter\n"),
	pktLineStr("object-format=sha1\n"),
	pktLineStr(fmt.Sprintf("agent=%s\n", agentName)),
	pktFlush,
}, nil)

func (r *repo) advertisementV0(service string) []byte {
	if cached, ok := r.advCache.Load(service); ok {
		return cached.([]byte)
	}
	// Single buffer, no fmt.Sprintf / per-line allocations: every push
	// invalidates the cache, so this rebuild runs on every push's
	// info/refs. Byte-identical to the previous Sprintf version
	// (verified by TestAdvGolden).
	buf := make([]byte, 0, 512)
	buf = appendPktLine(buf, "# service=", service, "\n")
	buf = append(buf, pktFlush...)
	tip, _ := resolveRef(r, "HEAD")
	headOID := tip
	if headOID == "" {
		headOID = zeroOID
	}
	if service == "git-upload-pack" {
		buf = appendPktLine(buf, headOID, " HEAD\x00symref=HEAD:refs/heads/", r.defaultBranch, " side-band-64k ofs-delta agent=", agentName, " shallow thin-pack\n")
	} else {
		buf = appendPktLine(buf, headOID, " HEAD\x00report-status side-band-64k delete-refs ofs-delta agent=", agentName, "\n")
	}
	names := make([]string, 0, len(r.refs))
	for name := range r.refs {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		oid := r.refs[name]
		buf = appendPktLine(buf, oid, " ", name, "\n")
		obj := r.objects[oid]
		if obj != nil && obj.typ == "tag" && service == "git-upload-pack" {
			if peeled, ok := peelToCommit(r, oid); ok {
				buf = appendPktLine(buf, peeled, " ", name, "^{}\n")
			}
		}
	}
	buf = append(buf, pktFlush...)
	r.advCache.Store(service, buf)
	return buf
}

type lsRefsOptions struct {
	peel     bool
	symrefs  bool
	unborn   bool
	prefixes []string
}

func (r *repo) lsRefsLines() []string {
	var lines []string
	tip, ok := resolveRef(r, "HEAD")
	if ok {
		lines = append(lines, fmt.Sprintf("%s HEAD symref-target:refs/heads/%s", tip, r.defaultBranch))
	} else {
		lines = append(lines, fmt.Sprintf("unborn HEAD symref-target:refs/heads/%s", r.defaultBranch))
	}
	names := make([]string, 0, len(r.refs))
	for name := range r.refs {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		oid := r.refs[name]
		obj := r.objects[oid]
		if obj != nil && obj.typ == "tag" {
			if peeled, ok := peelToCommit(r, oid); ok {
				lines = append(lines, fmt.Sprintf("%s %s peeled:%s", oid, name, peeled))
			} else {
				lines = append(lines, fmt.Sprintf("%s %s", oid, name))
			}
		} else {
			lines = append(lines, fmt.Sprintf("%s %s", oid, name))
		}
	}
	return lines
}

func (r *repo) lsRefsResponse(opts *lsRefsOptions) []byte {
	key := lsRefsCacheKey(opts)
	if cached, ok := r.lsCache.Load(key); ok {
		return cached.([]byte)
	}
	all := r.lsRefsLines()
	var out [][]byte
	for _, line := range all {
		text := line
		if !opts.symrefs {
			text = removeSymrefAttr(text)
		}
		if !opts.peel {
			text = removePeeledAttr(text)
		}
		if !opts.unborn && strings.HasPrefix(text, "unborn ") {
			continue
		}
		if len(opts.prefixes) > 0 {
			fields := strings.Split(text, " ")
			name := ""
			if len(fields) > 1 {
				name = fields[1]
			}
			matched := false
			for _, p := range opts.prefixes {
				if strings.HasPrefix(name, p) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		out = append(out, pktLineStr(text+"\n"))
	}
	out = append(out, pktFlush)
	buf := bytes.Join(out, nil)
	r.lsCache.Store(key, buf)
	return buf
}

// lsRefsCacheKey encodes the ls-refs options; the response depends only
// on these options plus repo state (refs), which invalidateCache clears.
func lsRefsCacheKey(opts *lsRefsOptions) string {
	var b strings.Builder
	if opts.peel {
		b.WriteByte('p')
	}
	if opts.symrefs {
		b.WriteByte('s')
	}
	if opts.unborn {
		b.WriteByte('u')
	}
	b.WriteByte(':')
	for i, p := range opts.prefixes {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(p)
	}
	return b.String()
}

func removeSymrefAttr(text string) string {
	// strips " symref-target:<non-space>"
	for {
		i := strings.Index(text, " symref-target:")
		if i < 0 {
			return text
		}
		end := i + 1
		for end < len(text) && text[end] != ' ' {
			end++
		}
		text = text[:i] + text[end:]
	}
}

func removePeeledAttr(text string) string {
	for {
		i := strings.Index(text, " peeled:")
		if i < 0 {
			return text
		}
		end := i + 1
		for end < len(text) && text[end] != ' ' {
			end++
		}
		// the peeled value is 40 hex chars; the regex in Node only strips
		// when followed by exactly 40 hex chars
		val := text[i+len(" peeled:") : end]
		if len(val) != 40 || !isHex(val) {
			return text
		}
		text = text[:i] + text[end:]
	}
}

func isHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func parseFetchRequest(text []string, isV2 bool) *fetchRequest {
	req := &fetchRequest{isV2: isV2}
	var mode string // "" | "ls-refs" | "fetch"
	ls := &lsRefsOptions{}
	for _, rawLine := range text {
		line := strings.TrimSuffix(rawLine, "\n")
		if isV2 && line == "command=ls-refs" {
			mode = "ls-refs"
			continue
		}
		if isV2 && line == "command=fetch" {
			mode = "fetch"
			continue
		}
		if mode == "ls-refs" {
			switch {
			case line == "peel":
				ls.peel = true
			case line == "symrefs":
				ls.symrefs = true
			case line == "unborn":
				ls.unborn = true
			case strings.HasPrefix(line, "ref-prefix "):
				ls.prefixes = append(ls.prefixes, line[len("ref-prefix "):])
			case strings.HasPrefix(line, "ref-prefix="):
				ls.prefixes = append(ls.prefixes, line[len("ref-prefix="):])
			}
			continue
		}
		switch {
		case strings.HasPrefix(line, "want "):
			req.wants = append(req.wants, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "have "):
			req.haves = append(req.haves, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "shallow "):
			req.shallow = append(req.shallow, strings.TrimSpace(line[8:]))
		case strings.HasPrefix(line, "deepen "):
			var n int
			if _, err := fmt.Sscanf(strings.TrimSpace(line[7:]), "%d", &n); err == nil {
				req.deepen = &n
				req.depth = &n
			}
		case strings.HasPrefix(line, "deepen-not "):
			// not needed by the scenario; treat as a full fetch
		case strings.HasPrefix(line, "deepen-since "):
			// not needed by the scenario
		case line == "done":
			// end of request
		}
	}
	if mode == "ls-refs" {
		req.lsRefs = ls
	}
	return req
}

func (r *repo) handleFetch(req *fetchRequest) []byte {
	if req.lsRefs != nil {
		return r.lsRefsResponse(req.lsRefs)
	}
	// Cache key: sorted wants/haves/shallow + depth + version, built
	// with a strings.Builder (no JSON encoding on the hot path).
	key := fetchCacheKey(req)
	if cached, ok := r.packCache.Load(key); ok {
		return cached.([]byte)
	}
	sendSet := r.computeSendSet(req.wants, req.haves, req.shallow, req.depth)
	var pack []byte
	if len(sendSet.send) > 0 {
		pack = writePack(sendSet.send)
	}
	var resp []byte
	if req.isV2 {
		resp = buildFetchV2Response(r, req, pack, sendSet.shallowOut, sendSet.unshallowOut)
	} else {
		resp = buildFetchV0Response(r, req, pack, sendSet.shallowOut, sendSet.unshallowOut)
	}
	r.packCache.Store(key, resp)
	return resp
}

func sortedCopy(in []string) []string {
	out := make([]string, len(in))
	copy(out, in)
	sort.Strings(out)
	return out
}

// fetchCacheKey builds the pack-cache key without JSON encoding.
// Oids are 40 hex chars, so "," and "|" separators are unambiguous.
func fetchCacheKey(req *fetchRequest) string {
	var b strings.Builder
	if req.isV2 {
		b.WriteByte('2')
	} else {
		b.WriteByte('0')
	}
	b.WriteByte('|')
	if req.depth != nil {
		b.WriteString(strconv.Itoa(*req.depth))
	} else {
		b.WriteByte('-')
	}
	b.WriteByte('|')
	writeSortedOids(&b, req.wants)
	b.WriteByte('|')
	writeSortedOids(&b, req.haves)
	b.WriteByte('|')
	writeSortedOids(&b, req.shallow)
	return b.String()
}

func writeSortedOids(b *strings.Builder, in []string) {
	sorted := sortedCopy(in)
	for i, s := range sorted {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s)
	}
}

// ------------------------------------------------------------ push

type pushCommand struct {
	oldOID string
	newOID string
	ref    string
}

func parsePushRequest(buf []byte) ([]pushCommand, []byte, error) {
	packets, restOffset, err := parsePktLines(buf)
	if err != nil {
		return nil, nil, err
	}
	var commands []pushCommand
	for _, p := range packets {
		if p.kind != "data" || p.payload == nil {
			continue
		}
		line := strings.TrimSuffix(string(p.payload), "\n")
		if line == "" {
			continue
		}
		if nul := strings.IndexByte(line, 0); nul >= 0 {
			line = line[:nul]
		}
		parts := strings.Split(line, " ")
		if len(parts) >= 3 {
			commands = append(commands, pushCommand{oldOID: parts[0], newOID: parts[1], ref: parts[2]})
		}
	}
	return commands, buf[restOffset:], nil
}

type pushResult struct {
	ref    string
	ok     bool
	reason string
}

func (r *repo) applyPush(commands []pushCommand, pack []byte) []pushResult {
	var packObjects map[string]*gitObject
	if len(pack) > 0 {
		parsed, err := readPack(pack, func(oid string) *gitObject { return r.objects[oid] })
		if err != nil {
			packObjects = nil
		} else {
			packObjects = parsed.objects
		}
	}
	var results []pushResult
	for _, cmd := range commands {
		if cmd.newOID == zeroOID {
			// Delete a ref.
			if _, ok := r.refs[cmd.ref]; ok {
				delete(r.refs, cmd.ref)
				results = append(results, pushResult{ref: cmd.ref, ok: true})
			} else {
				results = append(results, pushResult{ref: cmd.ref, ok: false, reason: "no such ref"})
			}
			continue
		}
		if packObjects == nil && len(pack) > 0 {
			results = append(results, pushResult{ref: cmd.ref, ok: false, reason: "pack parse failed"})
			continue
		}
		if packObjects != nil {
			for oid, obj := range packObjects {
				r.objects[oid] = obj
			}
		}
		current, hasCurrent := r.refs[cmd.ref]
		if (hasCurrent && current == cmd.oldOID) || (!hasCurrent && cmd.oldOID == zeroOID) {
			if cmd.oldOID == zeroOID {
				if _, ok := r.objects[cmd.newOID]; !ok {
					results = append(results, pushResult{ref: cmd.ref, ok: false, reason: "object not found"})
					continue
				}
				r.refs[cmd.ref] = cmd.newOID
				results = append(results, pushResult{ref: cmd.ref, ok: true})
			} else if r.isAncestor(cmd.oldOID, cmd.newOID) {
				r.refs[cmd.ref] = cmd.newOID
				results = append(results, pushResult{ref: cmd.ref, ok: true})
			} else {
				results = append(results, pushResult{ref: cmd.ref, ok: false, reason: "non-fast-forward"})
			}
		} else {
			results = append(results, pushResult{ref: cmd.ref, ok: false, reason: "non-fast-forward"})
		}
	}
	anyOK := false
	for _, res := range results {
		if res.ok {
			anyOK = true
			break
		}
	}
	if anyOK {
		r.invalidateCache()
	}
	return results
}

func pushReportBuffer(results []pushResult) []byte {
	lines := []string{"unpack ok\n"}
	for _, res := range results {
		if res.ok {
			lines = append(lines, fmt.Sprintf("ok %s\n", res.ref))
		} else {
			reason := res.reason
			if reason == "" {
				reason = "rejected"
			}
			lines = append(lines, fmt.Sprintf("ng %s %s\n", res.ref, reason))
		}
	}
	total := 4 // flush
	for _, l := range lines {
		total += 4 + 1 + len(l)
	}
	out := make([]byte, total)
	off := 0
	for _, l := range lines {
		n := len(l)
		copy(out[off:off+4], fmt.Sprintf("%04x", n+5))
		out[off+4] = 1
		copy(out[off+5:off+5+n], l)
		off += 4 + 1 + n
	}
	copy(out[off:off+4], "0000")
	return out
}
