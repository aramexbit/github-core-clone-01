// MCP (Model Context Protocol) over HTTP.
// Written fresh in Go for the v6 native core; behaviour mirrors the
// Node forge (app.ts) that passed 120/120 conformance.
package main

import (
	"fmt"
	"strings"
)

type mcpToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

var mcpTools = []mcpToolDef{
	{
		Name:        "create_repo",
		Description: "Create a repository owned by the authenticated user.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name":        map[string]any{"type": "string", "description": "Repository name"},
				"description": map[string]any{"type": "string", "description": "Repository description"},
				"private":     map[string]any{"type": "boolean", "description": "Whether the repository is private"},
			},
			"required": []string{"name"},
		},
	},
	{
		Name:        "get_repo",
		Description: "Get a repository by owner and name.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner": map[string]any{"type": "string", "description": "Repository owner"},
				"repo":  map[string]any{"type": "string", "description": "Repository name"},
			},
			"required": []string{"owner", "repo"},
		},
	},
	{
		Name:        "create_issue",
		Description: "Create an issue in a repository.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner": map[string]any{"type": "string"},
				"repo":  map[string]any{"type": "string"},
				"title": map[string]any{"type": "string"},
				"body":  map[string]any{"type": "string"},
			},
			"required": []string{"owner", "repo", "title"},
		},
	},
	{
		Name:        "list_issues",
		Description: "List issues in a repository.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner": map[string]any{"type": "string"},
				"repo":  map[string]any{"type": "string"},
				"state": map[string]any{"type": "string", "description": "open, closed or all"},
			},
			"required": []string{"owner", "repo"},
		},
	},
	{
		Name:        "create_pull_request",
		Description: "Create a pull request.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner": map[string]any{"type": "string"},
				"repo":  map[string]any{"type": "string"},
				"title": map[string]any{"type": "string"},
				"body":  map[string]any{"type": "string"},
				"head":  map[string]any{"type": "string", "description": "Head branch name"},
				"base":  map[string]any{"type": "string", "description": "Base branch name"},
			},
			"required": []string{"owner", "repo", "title", "head", "base"},
		},
	},
	{
		Name:        "merge_pull_request",
		Description: "Merge a pull request.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner":       map[string]any{"type": "string"},
				"repo":        map[string]any{"type": "string"},
				"pull_number": map[string]any{"type": "integer", "description": "Pull request number"},
			},
			"required": []string{"owner", "repo", "pull_number"},
		},
	},
}

func mcpToolOK(obj any) map[string]any {
	return map[string]any{
		"content":           []map[string]any{{"type": "text", "text": string(marshalJSON(obj))}},
		"structuredContent": obj,
	}
}

func mcpToolError(text string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
		"isError": true,
	}
}

type mcpRPCError struct {
	code    int
	message string
}

// mcpCallTool runs one tool. It returns (result, rpcErr): rpcErr is set
// only for the unknown-tool case, which the Node version answers as a
// JSON-RPC error instead of a tool error.
func mcpCallTool(s *forgeState, name string, args map[string]any) (map[string]any, *mcpRPCError) {
	var tool *mcpToolDef
	for i := range mcpTools {
		if mcpTools[i].Name == name {
			tool = &mcpTools[i]
			break
		}
	}
	if tool == nil {
		return nil, &mcpRPCError{code: -32602, message: fmt.Sprintf("unknown tool %s", name)}
	}
	if req, ok := tool.InputSchema["required"].([]string); ok {
		for _, r := range req {
			if args[r] == nil {
				return mcpToolError(fmt.Sprintf("missing required argument: %s", r)), nil
			}
		}
	}
	switch name {
	case "create_repo":
		repoName := fmt.Sprintf("%v", args["name"])
		if s.getRepo(viewerLogin, repoName) != nil {
			return mcpToolError(fmt.Sprintf("repository %s already exists", repoName)), nil
		}
		desc, _ := args["description"].(string)
		priv, _ := args["private"].(bool)
		r := s.createRepo(repoName, desc, priv)
		r.mu.RLock()
		j := repoToJSON(r)
		r.mu.RUnlock()
		return mcpToolOK(j), nil
	case "get_repo":
		r := s.getRepo(fmt.Sprintf("%v", args["owner"]), fmt.Sprintf("%v", args["repo"]))
		if r == nil {
			return mcpToolError("repository not found"), nil
		}
		r.mu.RLock()
		j := repoToJSON(r)
		r.mu.RUnlock()
		return mcpToolOK(j), nil
	case "create_issue":
		r := s.getRepo(fmt.Sprintf("%v", args["owner"]), fmt.Sprintf("%v", args["repo"]))
		if r == nil {
			return mcpToolError("repository not found"), nil
		}
		body, _ := args["body"].(string)
		iss := s.createIssue(r, fmt.Sprintf("%v", args["title"]), body, nil)
		r.mu.RLock()
		j := issueToJSON(r, iss)
		r.mu.RUnlock()
		return mcpToolOK(j), nil
	case "list_issues":
		r := s.getRepo(fmt.Sprintf("%v", args["owner"]), fmt.Sprintf("%v", args["repo"]))
		if r == nil {
			return mcpToolError("repository not found"), nil
		}
		stateFilter, _ := args["state"].(string)
		if stateFilter == "" {
			stateFilter = "open"
		}
		r.mu.RLock()
		list := r.sortedIssues(false)
		out := make([]map[string]any, 0, len(list))
		for _, iss := range list {
			if stateFilter != "all" && iss.state != stateFilter {
				continue
			}
			out = append(out, issueToJSON(r, iss))
		}
		r.mu.RUnlock()
		return mcpToolOK(out), nil
	case "create_pull_request":
		r := s.getRepo(fmt.Sprintf("%v", args["owner"]), fmt.Sprintf("%v", args["repo"]))
		if r == nil {
			return mcpToolError("repository not found"), nil
		}
		body, _ := args["body"].(string)
		p, errStr := s.createPull(r, fmt.Sprintf("%v", args["title"]), body, fmt.Sprintf("%v", args["head"]), fmt.Sprintf("%v", args["base"]))
		if errStr != "" || p == nil {
			if errStr == "" {
				errStr = "failed to create pull request"
			}
			return mcpToolError(errStr), nil
		}
		r.mu.RLock()
		j := pullToJSON(r, p)
		r.mu.RUnlock()
		return mcpToolOK(j), nil
	case "merge_pull_request":
		r := s.getRepo(fmt.Sprintf("%v", args["owner"]), fmt.Sprintf("%v", args["repo"]))
		if r == nil {
			return mcpToolError("repository not found"), nil
		}
		num := toInt(args["pull_number"])
		r.mu.Lock()
		p, ok := r.pulls[num]
		if !ok {
			r.mu.Unlock()
			return mcpToolError("pull request not found"), nil
		}
		if p.merged {
			j := map[string]any{"merged": true, "sha": p.mergeCommitSha, "message": "already merged"}
			r.mu.Unlock()
			return mcpToolOK(j), nil
		}
		if r.pullMergeable(p) != "MERGEABLE" {
			r.mu.Unlock()
			return mcpToolError("merge conflict"), nil
		}
		sha := r.squashMergePull(p, "")
		if sha == "" {
			r.mu.Unlock()
			return mcpToolError("merge conflict"), nil
		}
		j := map[string]any{"merged": true, "sha": sha, "message": fmt.Sprintf("%s (#%d)", p.title, p.number)}
		r.mu.Unlock()
		return mcpToolOK(j), nil
	}
	return mcpToolError(fmt.Sprintf("tool %s is not implemented", name)), nil
}

func handleMCP(s *forgeState, req *httpRequest) httpResponse {
	if req.method == "DELETE" {
		return httpResponse{status: 200, headers: map[string]string{}, body: nil}
	}
	if req.method != "POST" {
		return errJSON(405, "method not allowed")
	}
	var parsed any
	if err := unmarshalJSON(req.body, &parsed); err != nil {
		return jsonResp(400, map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "parse error"}}, nil)
	}
	msg, _ := parsed.(map[string]any)
	if msg == nil {
		msg = map[string]any{}
	}
	// Notification (no id): accept silently.
	id, hasID := msg["id"]
	if !hasID || id == nil {
		return httpResponse{status: 202, headers: map[string]string{}, body: nil}
	}
	method, _ := msg["method"].(string)
	params, _ := msg["params"].(map[string]any)
	if params == nil {
		params = map[string]any{}
	}
	ok := func(result any) httpResponse {
		return jsonResp(200, map[string]any{"jsonrpc": "2.0", "id": id, "result": result}, nil)
	}
	errResp := func(code int, message string) httpResponse {
		return jsonResp(200, map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}}, nil)
	}

	switch method {
	case "server/discover":
		return ok(map[string]any{
			"supportedVersions": []string{"2026-07-28", "2025-11-25"},
			"serverInfo":        map[string]any{"name": agentName, "version": "3.0.0"},
			"capabilities":      map[string]any{"tools": map[string]any{}},
		})
	case "initialize":
		requested, _ := params["protocolVersion"].(string)
		if requested == "" {
			requested = "2025-11-25"
		}
		return ok(map[string]any{
			"protocolVersion": requested,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": agentName, "version": "3.0.0"},
		})
	case "ping":
		return ok(map[string]any{})
	case "tools/list":
		return jsonResp(200, map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"tools": mcpTools}}, nil)
	case "tools/call":
		toolName, _ := params["name"].(string)
		args, _ := params["arguments"].(map[string]any)
		if args == nil {
			args = map[string]any{}
		}
		result, rpcErr := mcpCallTool(s, toolName, args)
		if rpcErr != nil {
			return errResp(rpcErr.code, rpcErr.message)
		}
		return ok(result)
	case "notifications/initialized":
		return httpResponse{status: 202, headers: map[string]string{}, body: nil}
	default:
		if strings.HasPrefix(method, "notifications/") {
			return httpResponse{status: 202, headers: map[string]string{}, body: nil}
		}
		return errResp(-32601, fmt.Sprintf("method not found: %s", method))
	}
}
