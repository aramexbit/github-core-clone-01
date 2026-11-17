// GraphQL v4 API: tokenizer, parser, resolver, mutations.
// Written fresh in Go for the v6 native core; behaviour mirrors the
// Node forge (app.ts) that passed 120/120 conformance.
package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type gqlValue struct {
	kind   string // "var" | "string" | "int" | "float" | "boolean" | "null" | "enum" | "list" | "object"
	value  any
	items  []*gqlValue
	fields []gqlFieldKV
}

type gqlFieldKV struct {
	name  string
	value *gqlValue
}

type gqlField struct {
	name         string
	alias        string
	args         map[string]*gqlValue
	selections   []*gqlField
	fragmentType string
	kind         string // "field" | "fragment" | "inline"
}

type gqlOperation struct {
	typ        string // "query" | "mutation"
	selections []*gqlField
}

// gqlUndefined marks a field that resolves to JS `undefined`: its key is
// omitted from the JSON output entirely.
var gqlUndefined = &struct{ undefined bool }{true}

func gqlTokenize(src string) ([]string, error) {
	var tokens []string
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',':
			i++
		case c == '#':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '.' && strings.HasPrefix(src[i:], "..."):
			tokens = append(tokens, "...")
			i += 3
		case strings.IndexByte("{}()[]:!=$@", c) >= 0:
			tokens = append(tokens, string(c))
			i++
		case c == '"':
			j := i + 1
			var out strings.Builder
			for j < len(src) && src[j] != '"' {
				if src[j] == '\\' && j+1 < len(src) {
					esc := src[j+1]
					switch esc {
					case 'n':
						out.WriteByte('\n')
					case 't':
						out.WriteByte('\t')
					case 'r':
						out.WriteByte('\r')
					default:
						out.WriteByte(esc)
					}
					j += 2
				} else {
					out.WriteByte(src[j])
					j++
				}
			}
			tokens = append(tokens, jsonString(out.String()))
			i = j + 1
		case (c >= '0' && c <= '9') || c == '-':
			j := i
			for j < len(src) && strings.IndexByte("0123456789.eE+-", src[j]) >= 0 {
				j++
			}
			tokens = append(tokens, src[i:j])
			i = j
		case (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_':
			j := i
			for j < len(src) && ((src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= 'a' && src[j] <= 'z') || (src[j] >= '0' && src[j] <= '9') || src[j] == '_') {
				j++
			}
			tokens = append(tokens, src[i:j])
			i = j
		default:
			return nil, fmt.Errorf("unexpected character %q in GraphQL document", string(c))
		}
	}
	return tokens, nil
}

type gqlParser struct {
	pos    int
	tokens []string
}

func (p *gqlParser) peek() string {
	if p.pos >= len(p.tokens) {
		return ""
	}
	return p.tokens[p.pos]
}

func (p *gqlParser) next() string {
	t := p.tokens[p.pos]
	p.pos++
	return t
}

func (p *gqlParser) expect(tok string) error {
	got := p.next()
	if got != tok {
		return fmt.Errorf("expected %s in GraphQL document, got %s", tok, got)
	}
	return nil
}

func (p *gqlParser) parseDocument() ([]*gqlOperation, error) {
	var ops []*gqlOperation
	for p.pos < len(p.tokens) {
		tok := p.peek()
		if tok == "query" || tok == "mutation" {
			p.next()
			if p.peek() != "" && p.peek() != "{" && p.peek() != "(" {
				p.next() // operation name
			}
			if p.peek() == "(" {
				p.skipParens()
			}
			sel, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			ops = append(ops, &gqlOperation{typ: tok, selections: sel})
		} else if tok == "{" {
			sel, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			ops = append(ops, &gqlOperation{typ: "query", selections: sel})
		} else {
			return nil, fmt.Errorf("unexpected token %s in GraphQL document", tok)
		}
	}
	return ops, nil
}

func (p *gqlParser) skipParens() {
	p.expect("(")
	depth := 1
	for depth > 0 {
		t := p.next()
		if t == "(" {
			depth++
		} else if t == ")" {
			depth--
		}
	}
}

func (p *gqlParser) parseSelectionSet() ([]*gqlField, error) {
	if err := p.expect("{"); err != nil {
		return nil, err
	}
	var out []*gqlField
	for p.peek() != "}" {
		f, err := p.parseField()
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if err := p.expect("}"); err != nil {
		return nil, err
	}
	return out, nil
}

func (p *gqlParser) parseField() (*gqlField, error) {
	tok := p.peek()
	if tok == "..." {
		p.next()
		if p.peek() == "on" {
			p.next()
			typeName := p.next()
			sel, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			return &gqlField{fragmentType: typeName, selections: sel, kind: "inline"}, nil
		}
		fragName := p.next()
		return &gqlField{name: fragName, kind: "fragment"}, nil
	}
	first := p.next()
	var alias string
	name := first
	if p.peek() == ":" {
		p.next()
		alias = first
		name = p.next()
	}
	args := map[string]*gqlValue{}
	if p.peek() == "(" {
		p.next()
		for p.peek() != ")" {
			argName := p.next()
			if err := p.expect(":"); err != nil {
				return nil, err
			}
			v, err := p.parseValue()
			if err != nil {
				return nil, err
			}
			args[argName] = v
		}
		if err := p.expect(")"); err != nil {
			return nil, err
		}
	}
	var selections []*gqlField
	if p.peek() == "{" {
		var err error
		selections, err = p.parseSelectionSet()
		if err != nil {
			return nil, err
		}
	}
	return &gqlField{name: name, alias: alias, args: args, selections: selections, kind: "field"}, nil
}

var intRe = regexp.MustCompile(`^-?[0-9]+$`)
var floatRe = regexp.MustCompile(`^-?[0-9]*\.[0-9]+([eE][+-]?[0-9]+)?$`)

func (p *gqlParser) parseValue() (*gqlValue, error) {
	tok := p.next()
	switch {
	case tok == "$":
		return &gqlValue{kind: "var", value: p.next()}, nil
	case tok == "[":
		var items []*gqlValue
		for p.peek() != "]" {
			v, err := p.parseValue()
			if err != nil {
				return nil, err
			}
			items = append(items, v)
		}
		if err := p.expect("]"); err != nil {
			return nil, err
		}
		return &gqlValue{kind: "list", items: items}, nil
	case tok == "{":
		var fields []gqlFieldKV
		for p.peek() != "}" {
			name := p.next()
			if err := p.expect(":"); err != nil {
				return nil, err
			}
			v, err := p.parseValue()
			if err != nil {
				return nil, err
			}
			fields = append(fields, gqlFieldKV{name, v})
		}
		if err := p.expect("}"); err != nil {
			return nil, err
		}
		return &gqlValue{kind: "object", fields: fields}, nil
	case tok == "true" || tok == "false":
		return &gqlValue{kind: "boolean", value: tok == "true"}, nil
	case tok == "null":
		return &gqlValue{kind: "null", value: nil}, nil
	case strings.HasPrefix(tok, "\""):
		var s string
		if err := unmarshalJSONString(tok, &s); err != nil {
			return nil, err
		}
		return &gqlValue{kind: "string", value: s}, nil
	case intRe.MatchString(tok):
		n, _ := strconv.Atoi(tok)
		return &gqlValue{kind: "int", value: n}, nil
	case floatRe.MatchString(tok):
		f, _ := strconv.ParseFloat(tok, 64)
		return &gqlValue{kind: "float", value: f}, nil
	default:
		return &gqlValue{kind: "enum", value: tok}, nil
	}
}

func gqlResolveValue(v *gqlValue, variables map[string]any) any {
	switch v.kind {
	case "var":
		return variables[v.value.(string)]
	case "list":
		out := make([]any, len(v.items))
		for i, x := range v.items {
			out[i] = gqlResolveValue(x, variables)
		}
		return out
	case "object":
		out := map[string]any{}
		for _, f := range v.fields {
			out[f.name] = gqlResolveValue(f.value, variables)
		}
		return out
	default:
		return v.value
	}
}

var typeFields = map[string][]string{
	"Query":                     {"viewer", "repository", "node", "search", "__type", "__schema"},
	"Mutation":                  {"createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"},
	"Viewer":                    {"login", "id", "name", "email"},
	"User":                      {"login", "id", "name", "email"},
	"Repository":                {"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "description", "private", "createdAt", "updatedAt"},
	"Issue":                     {"id", "number", "title", "body", "state", "url", "author", "createdAt", "updatedAt", "comments"},
	"PullRequest":               {"id", "number", "title", "body", "state", "headRefName", "baseRefName", "mergeable", "merged", "files", "author", "createdAt", "updatedAt"},
	"Ref":                       {"name", "target"},
	"IssueConnection":           {"nodes", "edges", "pageInfo", "totalCount"},
	"PullRequestConnection":     {"nodes", "edges", "pageInfo", "totalCount"},
	"PullRequestFileConnection": {"nodes", "edges", "pageInfo"},
	"IssueEdge":                 {"node", "cursor"},
	"PullRequestEdge":           {"node", "cursor"},
	"PageInfo":                  {"hasNextPage", "hasPreviousPage", "startCursor", "endCursor"},
	"PullRequestFile":           {"path", "additions", "deletions", "changes"},
	"IssueComment":              {"id", "body", "author", "createdAt"},
	"CommentEdge":               {"node", "cursor"},
	"CreateIssuePayload":        {"issue", "clientMutationId"},
	"CloseIssuePayload":         {"issue", "clientMutationId"},
	"CreatePullRequestPayload":  {"pullRequest", "clientMutationId"},
	"MergePullRequestPayload":   {"pullRequest", "clientMutationId"},
	"AddCommentPayload":         {"commentEdge", "clientMutationId"},
	"__Type":                    {"name", "fields", "enumValues", "kind"},
	"__Field":                   {"name", "type"},
	"__EnumValue":               {"name"},
}

var searchTypeValues = []string{"ISSUE", "PULL_REQUEST", "REPOSITORY", "USER", "ORGANIZATION", "DISCUSSION", "COMMIT"}

type gqlContext struct {
	state     *forgeState
	errors    []map[string]string
	variables map[string]any
}

func (c *gqlContext) gqlError(message string) {
	c.errors = append(c.errors, map[string]string{"message": message})
}

// findRepoByID resolves a repository reference: numeric databaseId or a
// base64 global id ("Repository:<dbId>").
func (c *gqlContext) findRepoByID(v any) *repo {
	switch t := v.(type) {
	case float64:
		return c.findRepoByDBID(int(t))
	case int:
		return c.findRepoByDBID(t)
	}
	s := fmt.Sprintf("%v", v)
	if n, err := strconv.Atoi(s); err == nil {
		return c.findRepoByDBID(n)
	}
	decoded := b64decode(s)
	if strings.HasPrefix(decoded, "Repository:") {
		if n, err := strconv.Atoi(strings.TrimPrefix(decoded, "Repository:")); err == nil {
			return c.findRepoByDBID(n)
		}
	}
	return nil
}

func (c *gqlContext) findRepoByDBID(n int) *repo {
	c.state.mu.RLock()
	defer c.state.mu.RUnlock()
	for _, r := range c.state.repos {
		if r.id == n {
			return r
		}
	}
	return nil
}

// decodeNodeID decodes a global node id ("Kind:<dbId>") or a plain number.
func decodeNodeID(v any) (kind string, dbID int, ok bool) {
	if n, isNum := v.(float64); isNum {
		return "", int(n), true
	}
	if n, isNum := v.(int); isNum {
		return "", n, true
	}
	s := fmt.Sprintf("%v", v)
	if n, err := strconv.Atoi(s); err == nil {
		return "", n, true
	}
	decoded := b64decode(s)
	parts := strings.SplitN(decoded, ":", 2)
	if len(parts) != 2 {
		return "", 0, false
	}
	n, err := strconv.Atoi(parts[1])
	if err != nil {
		return "", 0, false
	}
	return parts[0], n, true
}

type gqlWrapped struct {
	repo *repo
	item any // *issue or *pull
}

type gqlConn struct {
	nodes    []any
	pageInfo *gqlPageInfo
}

type gqlPageInfo struct {
	hasNextPage bool
	endCursor   *string
}

func gqlSelect(ctx *gqlContext, typeName string, value any, selections []*gqlField) map[string]any {
	out := map[string]any{}
	for _, field := range selections {
		if field.kind == "fragment" {
			continue
		}
		if field.kind == "inline" {
			sub := gqlSelect(ctx, typeName, value, field.selections)
			for k, v := range sub {
				out[k] = v
			}
			continue
		}
		key := field.name
		if field.alias != "" {
			key = field.alias
		}
		res := gqlResolveField(ctx, typeName, value, field)
		if res == gqlUndefined {
			continue
		}
		out[key] = res
	}
	return out
}

func gqlResolveField(ctx *gqlContext, typeName string, value any, field *gqlField) any {
	name := field.name
	args := map[string]any{}
	for k, v := range field.args {
		args[k] = gqlResolveValue(v, ctx.variables)
	}
	if known, ok := typeFields[typeName]; ok {
		found := false
		for _, f := range known {
			if f == name {
				found = true
				break
			}
		}
		if !found {
			ctx.gqlError(fmt.Sprintf("Cannot query field %q on type %q.", name, typeName))
			return gqlUndefined
		}
	}
	repo, _ := value.(*repo)
	switch typeName {
	case "Query":
		switch name {
		case "viewer":
			return gqlSelect(ctx, "Viewer", nil, field.selections)
		case "repository":
			owner := fmt.Sprintf("%v", args["owner"])
			rname := fmt.Sprintf("%v", args["name"])
			found := ctx.state.getRepo(owner, rname)
			if found == nil {
				return nil
			}
			return gqlSelect(ctx, "Repository", found, field.selections)
		case "node":
			id := fmt.Sprintf("%v", args["id"])
			decoded := b64decode(id)
			parts := strings.SplitN(decoded, ":", 2)
			if len(parts) != 2 {
				return nil
			}
			dbID, err := strconv.Atoi(parts[1])
			if err != nil {
				return nil
			}
			kind := parts[0]
			if kind == "Repository" {
				ctx.state.mu.RLock()
				defer ctx.state.mu.RUnlock()
				for _, r := range ctx.state.repos {
					if r.id == dbID {
						return gqlSelect(ctx, "Repository", r, field.selections)
					}
				}
				return nil
			}
			if kind == "Issue" || kind == "PullRequest" {
				ctx.state.mu.RLock()
				defer ctx.state.mu.RUnlock()
				for _, r := range ctx.state.repos {
					var item any
					if kind == "Issue" {
						if it, ok := r.issues[dbID]; ok {
							item = it
						}
					} else {
						if it, ok := r.pulls[dbID]; ok {
							item = it
						}
					}
					if item != nil {
						return gqlSelect(ctx, kind, &gqlWrapped{repo: r, item: item}, field.selections)
					}
				}
				return nil
			}
			return nil
		case "__type":
			tname := fmt.Sprintf("%v", args["name"])
			if _, ok := typeFields[tname]; !ok && tname != "SearchType" {
				return nil
			}
			return gqlSelect(ctx, "__Type", tname, field.selections)
		case "__schema":
			return map[string]any{}
		}
		return nil
	case "Viewer", "User":
		switch name {
		case "login":
			return viewerLogin
		case "id":
			return globalID("User", viewerID)
		case "name":
			return viewerName
		case "email":
			return viewerEmail
		}
		return nil
	case "Repository":
		if repo == nil {
			return nil
		}
		switch name {
		case "id":
			return globalID("Repository", repo.id)
		case "databaseId":
			return repo.id
		case "name":
			return repo.name
		case "nameWithOwner":
			return repoFullName(repo)
		case "owner":
			return gqlSelect(ctx, "User", nil, field.selections)
		case "defaultBranchRef":
			tip, ok := resolveRef(repo, "HEAD")
			if !ok {
				return nil
			}
			return gqlSelect(ctx, "Ref", map[string]any{"name": repo.defaultBranch, "oid": tip}, field.selections)
		case "viewerPermission":
			return "ADMIN"
		case "hasIssuesEnabled":
			return true
		case "description":
			return repo.description
		case "private":
			return repo.priv
		case "createdAt":
			return isoNow()
		case "updatedAt":
			return isoNow()
		case "issue":
			num := toInt(args["number"])
			iss, ok := repo.issues[num]
			if !ok {
				return nil
			}
			return gqlSelect(ctx, "Issue", &gqlWrapped{repo: repo, item: iss}, field.selections)
		case "issues":
			return gqlIssuesConnection(ctx, repo, args, field)
		case "pullRequests":
			return gqlPullsConnection(ctx, repo, args, field)
		case "pullRequest":
			num := toInt(args["number"])
			p, ok := repo.pulls[num]
			if !ok {
				return nil
			}
			return gqlSelect(ctx, "PullRequest", &gqlWrapped{repo: repo, item: p}, field.selections)
		}
		return nil
	case "Issue":
		wrapped := value.(*gqlWrapped)
		iss := wrapped.item.(*issue)
		switch name {
		case "id":
			return globalID("Issue", iss.id)
		case "number":
			return iss.number
		case "title":
			return iss.title
		case "body":
			return iss.body
		case "state":
			if iss.state == "open" {
				return "OPEN"
			}
			return "CLOSED"
		case "url":
			return fmt.Sprintf("https://example.invalid/%s/%s/issues/%d", wrapped.repo.owner, wrapped.repo.name, iss.number)
		case "author":
			return gqlSelect(ctx, "User", nil, field.selections)
		case "createdAt":
			return iss.createdAt
		case "updatedAt":
			return iss.updatedAt
		case "comments":
			return map[string]any{"nodes": []any{}}
		}
		return nil
	case "PullRequest":
		wrapped := value.(*gqlWrapped)
		p := wrapped.item.(*pull)
		switch name {
		case "id":
			return globalID("PullRequest", p.id)
		case "number":
			return p.number
		case "title":
			return p.title
		case "body":
			return p.body
		case "state":
			if p.merged {
				return "MERGED"
			}
			if p.state == "open" {
				return "OPEN"
			}
			return "CLOSED"
		case "headRefName":
			return p.head
		case "baseRefName":
			return p.base
		case "mergeable":
			return wrapped.repo.pullMergeable(p)
		case "merged":
			return p.merged
		case "author":
			return gqlSelect(ctx, "User", nil, field.selections)
		case "createdAt":
			return p.createdAt
		case "updatedAt":
			return p.createdAt
		case "files":
			var baseTree, headTree string
			var hasBase, hasHead bool
			if baseCommit := wrapped.repo.objects[p.baseSha]; baseCommit != nil && baseCommit.typ == "commit" {
				baseTree = parseCommit(baseCommit.data).tree
				hasBase = true
			}
			if headCommit := wrapped.repo.objects[p.headSha]; headCommit != nil && headCommit.typ == "commit" {
				headTree = parseCommit(headCommit.data).tree
				hasHead = true
			}
			files := wrapped.repo.diffTrees(baseTree, headTree, hasBase, hasHead)
			nodes := make([]any, len(files))
			for i := range files {
				nodes[i] = files[i]
			}
			return gqlSelect(ctx, "PullRequestFileConnection", &gqlConn{nodes: nodes}, field.selections)
		}
		return nil
	case "Ref":
		ref := value.(map[string]any)
		switch name {
		case "name":
			return ref["name"]
		case "target":
			return nil
		}
		return nil
	case "IssueConnection", "PullRequestConnection", "PullRequestFileConnection":
		conn := value.(*gqlConn)
		switch name {
		case "nodes":
			typeName2 := "Issue"
			if typeName == "PullRequestConnection" {
				typeName2 = "PullRequest"
			} else if typeName == "PullRequestFileConnection" {
				typeName2 = "PullRequestFile"
			}
			out := make([]any, len(conn.nodes))
			for i, n := range conn.nodes {
				out[i] = gqlSelect(ctx, typeName2, n, field.selections)
			}
			return out
		case "edges":
			return []any{}
		case "pageInfo":
			return gqlSelect(ctx, "PageInfo", conn, field.selections)
		case "totalCount":
			return len(conn.nodes)
		}
		return nil
	case "PageInfo":
		conn := value.(*gqlConn)
		info := conn.pageInfo
		switch name {
		case "hasNextPage":
			if info != nil {
				return info.hasNextPage
			}
			return false
		case "hasPreviousPage":
			return false
		case "endCursor":
			if info != nil && info.endCursor != nil {
				return *info.endCursor
			}
			return nil
		case "startCursor":
			return nil
		}
		return nil
	case "PullRequestFile":
		f := value.(fileDiff)
		switch name {
		case "path":
			return f.filename
		case "additions":
			return f.additions
		case "deletions":
			return f.deletions
		case "changes":
			return f.changes
		}
		return nil
	case "IssueComment":
		c := value.(*comment)
		switch name {
		case "id":
			return globalID("IssueComment", c.id)
		case "body":
			return c.body
		case "author":
			return gqlSelect(ctx, "User", nil, field.selections)
		case "createdAt":
			return c.createdAt
		}
		return nil
	case "CommentEdge":
		c := value.(*comment)
		switch name {
		case "node":
			return gqlSelect(ctx, "IssueComment", c, field.selections)
		case "cursor":
			return b64encode(fmt.Sprintf("cursor:%d", c.id))
		}
		return nil
	case "__Type":
		tname := value.(string)
		switch name {
		case "name":
			return tname
		case "kind":
			if tname == "SearchType" {
				return "ENUM"
			}
			return "OBJECT"
		case "fields":
			fields := typeFields[tname]
			out := make([]any, len(fields))
			for i, f := range fields {
				out[i] = gqlSelect(ctx, "__Field", map[string]any{"name": f}, field.selections)
			}
			return out
		case "enumValues":
			if tname != "SearchType" {
				return nil
			}
			out := make([]any, len(searchTypeValues))
			for i, v := range searchTypeValues {
				out[i] = gqlSelect(ctx, "__EnumValue", map[string]any{"name": v}, field.selections)
			}
			return out
		}
		return nil
	case "__Field":
		f := value.(map[string]any)
		switch name {
		case "name":
			return f["name"]
		case "type":
			return nil
		}
		return nil
	case "__EnumValue":
		v := value.(map[string]any)
		if name == "name" {
			return v["name"]
		}
		return nil
	}
	return nil
}

func toInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case string:
		n, _ := strconv.Atoi(t)
		return n
	}
	return 0
}

func gqlIssuesConnection(ctx *gqlContext, r *repo, args map[string]any, field *gqlField) map[string]any {
	list := r.sortedIssues(false)
	if states, ok := args["states"].([]any); ok && len(states) > 0 {
		wanted := map[string]bool{}
		for _, st := range states {
			wanted[strings.ToLower(fmt.Sprintf("%v", st))] = true
		}
		filtered := list[:0]
		for _, iss := range list {
			if wanted[iss.state] {
				filtered = append(filtered, iss)
			}
		}
		list = filtered
	}
	if orderBy, ok := args["orderBy"].(map[string]any); ok {
		if strings.ToUpper(fmt.Sprintf("%v", orderBy["direction"])) == "DESC" {
			for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
				list[i], list[j] = list[j], list[i]
			}
		}
	}
	first := len(list)
	if f, ok := args["first"].(float64); ok {
		first = int(f)
	} else if f, ok := args["first"].(int); ok {
		first = f
	}
	start := 0
	if args["after"] != nil {
		decoded := b64decode(fmt.Sprintf("%v", args["after"]))
		parts := strings.Split(decoded, ":")
		if len(parts) == 2 {
			if n, err := strconv.Atoi(parts[1]); err == nil && n > 0 {
				start = n
			}
		}
	}
	end := start + first
	if end > len(list) {
		end = len(list)
	}
	if start > len(list) {
		start = len(list)
		end = start
	}
	page := list[start:end]
	hasNext := start+first < len(list)
	var endCursor *string
	if len(page) > 0 {
		c := b64encode(fmt.Sprintf("cursor:%d", start+len(page)))
		endCursor = &c
	}
	wrapped := make([]any, len(page))
	for i, item := range page {
		wrapped[i] = &gqlWrapped{repo: r, item: item}
	}
	conn := &gqlConn{nodes: wrapped, pageInfo: &gqlPageInfo{hasNextPage: hasNext, endCursor: endCursor}}
	return gqlSelect(ctx, "IssueConnection", conn, field.selections)
}

func gqlPullsConnection(ctx *gqlContext, r *repo, args map[string]any, field *gqlField) map[string]any {
	list := r.sortedPulls(false)
	first := len(list)
	if f, ok := args["first"].(float64); ok {
		first = int(f)
	} else if f, ok := args["first"].(int); ok {
		first = f
	}
	start := 0
	if args["after"] != nil {
		decoded := b64decode(fmt.Sprintf("%v", args["after"]))
		parts := strings.Split(decoded, ":")
		if len(parts) == 2 {
			if n, err := strconv.Atoi(parts[1]); err == nil && n > 0 {
				start = n
			}
		}
	}
	end := start + first
	if end > len(list) {
		end = len(list)
	}
	if start > len(list) {
		start = len(list)
		end = start
	}
	page := list[start:end]
	hasNext := start+first < len(list)
	var endCursor *string
	if len(page) > 0 {
		c := b64encode(fmt.Sprintf("cursor:%d", start+len(page)))
		endCursor = &c
	}
	wrapped := make([]any, len(page))
	for i, item := range page {
		wrapped[i] = &gqlWrapped{repo: r, item: item}
	}
	conn := &gqlConn{nodes: wrapped, pageInfo: &gqlPageInfo{hasNextPage: hasNext, endCursor: endCursor}}
	return gqlSelect(ctx, "PullRequestConnection", conn, field.selections)
}

func gqlExecuteMutation(ctx *gqlContext, op *gqlOperation, variables map[string]any) map[string]any {
	out := map[string]any{}
	for _, field := range op.selections {
		key := field.name
		if field.alias != "" {
			key = field.alias
		}
		args := map[string]any{}
		for k, v := range field.args {
			args[k] = gqlResolveValue(v, variables)
		}
		input, _ := args["input"].(map[string]any)
		switch field.name {
		case "createIssue":
			r := ctx.findRepoByID(input["repositoryId"])
			if r == nil {
				ctx.gqlError(fmt.Sprintf("repository %v not found", input["repositoryId"]))
				out[key] = nil
				continue
			}
			iss := ctx.state.createIssue(r, fmt.Sprintf("%v", input["title"]), fmt.Sprintf("%v", input["body"]), nil)
			out[key] = gqlSelectPayload(ctx, "CreateIssuePayload", &gqlWrapped{repo: r, item: iss}, field.selections)
		case "closeIssue":
			_, dbID, ok := decodeNodeID(input["issueId"])
			var target *gqlWrapped
			if ok {
				ctx.state.mu.RLock()
				for _, r := range ctx.state.repos {
					if it, has := r.issues[dbID]; has {
						target = &gqlWrapped{repo: r, item: it}
						break
					}
				}
				ctx.state.mu.RUnlock()
			}
			if target == nil {
				ctx.gqlError(fmt.Sprintf("issue %v not found", input["issueId"]))
				out[key] = nil
				continue
			}
			target.repo.mu.Lock()
			target.item.(*issue).state = "closed"
			target.item.(*issue).updatedAt = isoNow()
			target.item.(*issue).json = []byte(issueJSONString(target.repo, target.item.(*issue)))
			target.repo.mu.Unlock()
			out[key] = gqlSelectPayload(ctx, "CloseIssuePayload", target, field.selections)
		case "createPullRequest":
			r := ctx.findRepoByID(input["repositoryId"])
			if r == nil {
				ctx.gqlError(fmt.Sprintf("repository %v not found", input["repositoryId"]))
				out[key] = nil
				continue
			}
			p, errStr := ctx.state.createPull(r, fmt.Sprintf("%v", input["title"]), fmt.Sprintf("%v", input["body"]), fmt.Sprintf("%v", input["headRefName"]), fmt.Sprintf("%v", input["baseRefName"]))
			if errStr != "" || p == nil {
				if errStr == "" {
					errStr = "failed to create pull request"
				}
				ctx.gqlError(errStr)
				out[key] = nil
				continue
			}
			out[key] = gqlSelectPayload(ctx, "CreatePullRequestPayload", &gqlWrapped{repo: r, item: p}, field.selections)
		case "mergePullRequest":
			_, dbID, ok := decodeNodeID(input["pullRequestId"])
			var target *gqlWrapped
			if ok {
				ctx.state.mu.RLock()
				for _, r := range ctx.state.repos {
					if it, has := r.pulls[dbID]; has {
						target = &gqlWrapped{repo: r, item: it}
						break
					}
				}
				ctx.state.mu.RUnlock()
			}
			if target == nil {
				ctx.gqlError(fmt.Sprintf("pull request %v not found", input["pullRequestId"]))
				out[key] = nil
				continue
			}
			target.repo.mu.Lock()
			if target.repo.pullMergeable(target.item.(*pull)) != "MERGEABLE" {
				target.repo.mu.Unlock()
				ctx.gqlError("merge conflict")
				out[key] = nil
				continue
			}
			target.repo.squashMergePull(target.item.(*pull), "")
			target.repo.mu.Unlock()
			out[key] = gqlSelectPayload(ctx, "MergePullRequestPayload", target, field.selections)
		case "addComment":
			kind, dbID, ok := decodeNodeID(input["subjectId"])
			var target *gqlWrapped
			if ok {
				ctx.state.mu.RLock()
				for _, r := range ctx.state.repos {
					var item any
					if kind == "PullRequest" {
						if it, has := r.pulls[dbID]; has {
							item = it
						}
					} else {
						if it, has := r.issues[dbID]; has {
							item = it
						}
					}
					if item != nil {
						target = &gqlWrapped{repo: r, item: item}
						break
					}
				}
				ctx.state.mu.RUnlock()
			}
			if target == nil {
				ctx.gqlError(fmt.Sprintf("subject %v not found", input["subjectId"]))
				out[key] = nil
				continue
			}
			c := &comment{body: fmt.Sprintf("%v", input["body"]), user: viewerLogin, createdAt: isoNow()}
			ctx.state.mu.Lock()
			c.id = ctx.state.nextCommentID
			ctx.state.nextCommentID++
			ctx.state.mu.Unlock()
			target.repo.mu.Lock()
			var num int
			switch it := target.item.(type) {
			case *issue:
				num = it.number
			case *pull:
				num = it.number
			}
			target.repo.comments[num] = append(target.repo.comments[num], c)
			target.repo.mu.Unlock()
			out[key] = gqlSelectPayload(ctx, "AddCommentPayload", &gqlWrappedWithComment{gqlWrapped: &gqlWrapped{repo: target.repo, item: target.item}, comment: c}, field.selections)
		default:
			ctx.gqlError(fmt.Sprintf("Cannot query field %q on type \"Mutation\".", field.name))
			out[key] = nil
		}
	}
	return out
}

type gqlWrappedWithComment struct {
	*gqlWrapped
	comment *comment
}

func gqlSelectPayload(ctx *gqlContext, typeName string, value any, selections []*gqlField) map[string]any {
	out := map[string]any{}
	for _, field := range selections {
		key := field.name
		if field.alias != "" {
			key = field.alias
		}
		switch field.name {
		case "issue", "pullRequest":
			wrapped := value.(*gqlWrapped)
			t := "Issue"
			if field.name == "pullRequest" {
				t = "PullRequest"
			}
			out[key] = gqlSelect(ctx, t, wrapped, field.selections)
		case "commentEdge":
			var c *comment
			if wc, ok := value.(*gqlWrappedWithComment); ok {
				c = wc.comment
			}
			out[key] = gqlSelect(ctx, "CommentEdge", c, field.selections)
		case "clientMutationId":
			out[key] = nil
		default:
			out[key] = nil
		}
	}
	return out
}

func handleGraphQL(s *forgeState, body []byte) httpResponse {
	var parsed any
	if err := unmarshalJSON(body, &parsed); err != nil {
		return jsonResp(400, map[string]any{"message": "invalid JSON body"}, nil)
	}
	requests, isArray := parsed.([]any)
	if !isArray {
		requests = []any{parsed}
	}
	results := make([]map[string]any, 0, len(requests))
	for _, reqAny := range requests {
		req, _ := reqAny.(map[string]any)
		doc, _ := req["query"].(string)
		variables, _ := req["variables"].(map[string]any)
		if variables == nil {
			variables = map[string]any{}
		}
		if doc == "" {
			results = append(results, map[string]any{"data": nil, "errors": []map[string]string{{"message": "query is required"}}})
			continue
		}
		tokens, err := gqlTokenize(doc)
		if err != nil {
			results = append(results, map[string]any{"data": nil, "errors": []map[string]string{{"message": err.Error()}}})
			continue
		}
		parser := &gqlParser{tokens: tokens}
		ops, err := parser.parseDocument()
		if err != nil {
			results = append(results, map[string]any{"data": nil, "errors": []map[string]string{{"message": err.Error()}}})
			continue
		}
		ctx := &gqlContext{state: s, variables: variables}
		data := map[string]any{}
		for _, op := range ops {
			if op.typ == "mutation" {
				for k, v := range gqlExecuteMutation(ctx, op, variables) {
					data[k] = v
				}
			} else {
				for _, field := range op.selections {
					key := field.name
					if field.alias != "" {
						key = field.alias
					}
					args := map[string]any{}
					for k, v := range field.args {
						args[k] = gqlResolveValue(v, variables)
					}
					res := gqlResolveFieldWithArgs(ctx, "Query", nil, field, args)
					if res == gqlUndefined {
						continue
					}
					data[key] = res
				}
			}
		}
		result := map[string]any{"data": data}
		if len(ctx.errors) > 0 {
			errs := make([]map[string]string, len(ctx.errors))
			copy(errs, ctx.errors)
			result["errors"] = errs
		}
		results = append(results, result)
	}
	if isArray {
		return jsonResp(200, results, nil)
	}
	return jsonResp(200, results[0], nil)
}

// gqlResolveFieldWithArgs swaps the field's args for variable-resolved
// values, calls the resolver, then restores the args.
func gqlResolveFieldWithArgs(ctx *gqlContext, typeName string, value any, field *gqlField, args map[string]any) any {
	saved := field.args
	asValues := map[string]*gqlValue{}
	for k, v := range args {
		switch t := v.(type) {
		case float64:
			asValues[k] = &gqlValue{kind: "int", value: int(t)}
		case bool:
			asValues[k] = &gqlValue{kind: "boolean", value: t}
		case nil:
			asValues[k] = &gqlValue{kind: "null", value: nil}
		case []any:
			items := make([]*gqlValue, len(t))
			for i, x := range t {
				items[i] = &gqlValue{kind: "string", value: fmt.Sprintf("%v", x)}
			}
			asValues[k] = &gqlValue{kind: "list", items: items}
		case map[string]any:
			fields := make([]gqlFieldKV, 0, len(t))
			for fk, fv := range t {
				fields = append(fields, gqlFieldKV{name: fk, value: &gqlValue{kind: "string", value: fmt.Sprintf("%v", fv)}})
			}
			asValues[k] = &gqlValue{kind: "object", fields: fields}
		default:
			asValues[k] = &gqlValue{kind: "string", value: v}
		}
	}
	field.args = asValues
	out := gqlResolveField(ctx, typeName, value, field)
	field.args = saved
	return out
}

func unmarshalJSONString(s string, v *string) error {
	return unmarshalJSON([]byte(s), v)
}
