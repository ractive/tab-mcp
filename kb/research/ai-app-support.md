---
type: research
title: "AI app support for MCP 2026-07-28 and CIMD (October 2026)"
description: Which AI apps speak the stateless 2026-07-28 revision and register OAuth clients via Client ID Metadata Documents, and the client bugs a strict server hits.
tags:
  - mcp
  - compatibility
  - oauth
timestamp: 2026-10-19T20:00:00+02:00
---

# AI app support for MCP 2026-07-28 and CIMD (October 2026)

**Verdict: "2026-07-28 only" plus "CIMD only" does not lock out Claude (claude.ai, Desktop,
Claude Code) or ChatGPT.** CIMD support is documented for all of them. 2026-07-28 is
documented for Claude Code, observed in server logs for claude.ai, and inferred from
third-party logs for ChatGPT (OpenAI documents no revision). VS Code/Copilot, Cursor,
Gemini CLI and (by default) Codex are locked out today.

## Matrix

Evidence levels: *documented* (vendor docs/changelog), *observed* (server logs in public
issues), *inferred*.

| App | 2026-07-28 | Falls back to older | CIMD | Notes |
|---|---|---|---|---|
| claude.ai web, Desktop, mobile (custom connectors) | yes, observed (`server/discover … proto=2026-07-28 -> 200`, claude-ai-mcp #1027, 2026-09-13); Anthropic blog says "being rolled out" | yes, inferred | **yes, documented** ("Use Claude's published identity") | Uses CIMD only if AS metadata has `client_id_metadata_document_supported: true` **and** `none` in `token_endpoint_auth_methods_supported`; else DCR. Redirect `https://claude.ai/api/mcp/auth_callback`. |
| Claude Code (`claude mcp add --transport http`) | **yes, documented** (v2 runtime on SDK 2.0, default since 2.1.274) | yes, documented | **yes, documented** (changelog 2.1.81) | Client id `https://claude.ai/oauth/claude-code-client-metadata`, redirects `http://localhost/callback` and `http://127.0.0.1/callback` with a random port (`--callback-port` fixes it); fails sign-in on an `iss` mismatch. |
| ChatGPT (developer mode, apps) | likely, inferred (third-party logs show `openai-mcp` sending `server/discover` on 2026-07-28) | unclear | **yes, documented** ("ChatGPT prioritizes CIMD when it is available") | Needs S256 in metadata; sends `resource`; redirect `https://chatgpt.com/connector/oauth/{callback_id}`. Plan availability (Plus vs Pro) unresolved. |
| VS Code / GitHub Copilot | no (2025-11-25, no fallback list) | n/a | partial | locked out by 2026-07-28-only |
| Cursor | unknown | unknown | **no** (staff, 2026-09-22: "still on our radar") | locked out by CIMD-only |
| Codex CLI | behind flag `mcp_2026_07_28 = true` | legacy by default | yes (PR #38089, 2026-08-12) | locked out by default |
| Gemini CLI | no (SDK 1.23, 2025-06-18) | n/a | no | locked out by both |
| MCP Inspector 2.x | yes | — | unknown | reference client |

SDK defaults matter because many clients embed them: the TS SDK v2 **client** defaults to
the legacy handshake (`auto` or `pin` must be chosen); the Python SDK v2 client defaults to
`auto` (probe, then fall back). The spec says a legacy client against a modern-only server
"fails" with no fall-forward.

## Client bugs a strict 2026-07-28 server hits

- **claude-code #93290 (open):** Desktop and the CLI via claude.ai connectors send the
  header `Mcp-Protocol-Version: 2025-11-25` while `_meta` says `2026-07-28`; a strict server
  rejects every call with `-32020`. tab-mcp tolerates this one mismatch in the relay (see
  [decision log](/decision-log.md)).
- **claude-ai-mcp #1027:** claude.ai does not retry a state-only `input_required` result —
  avoid MRTR with claude.ai (tab-mcp does not use it).
- **claude-code #88128, claude-ai-mcp #859:** results without `ttlMs`, `cacheScope` or
  `resultType` were rejected (fixed in Claude Code 2.1.302); the SDK always emits them.
- **claude-code #91414:** the first turn blocks for `MCP_TIMEOUT − 5000` ms while the server
  holds `subscriptions/listen` open; slows e2e tests.

## Requirements this puts on tab-mcp's authorization server

- `client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported`
  containing `none`, `code_challenge_methods_supported: ["S256"]`.
- `iss` in the authorization response and
  `authorization_response_iss_parameter_supported: true`.
- 401 with `WWW-Authenticate: Bearer resource_metadata=…`.
- `resource` accepted as the canonical address.
- Loopback redirect URIs (`http://localhost/…`, `http://127.0.0.1/…`) matched with the port
  ignored (RFC 8252 §7.3), everything else exactly.
- Answer within about 10 s.

## Driving Claude Code in an end-to-end test

- `claude -p` cannot do the OAuth browser step. Sign in once interactively
  (`claude mcp login <name>`, or `/mcp`), or pass a bearer token.
- Headless: `claude -p --mcp-config cfg.json --strict-mcp-config --allowedTools
  "mcp__calc__*" "…"` with `{"type":"http","url":"…","headers":{"Authorization":"Bearer
  ${TABMCP_TOKEN}"}}` (or `headersHelper`). With an `Authorization` header Claude Code does
  not fall back to OAuth. Variables named like Claude credentials expand to empty; use an
  own name.
- So the automated e2e can obtain a token by running the OAuth flow with the SDK client (and
  the tab auto-approving in test mode) and hand it to `claude -p`. A real CIMD sign-in with
  Claude Code stays a manual check in the compatibility matrix.
- `MCP_PROTOCOL_NEGOTIATION=legacy` turns Claude Code into a legacy client (negative test).

# Citations

- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
- [Claude Code changelog](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md)
- [Claude Code client metadata document](https://claude.ai/oauth/claude-code-client-metadata)
- [Claude connectors: authentication](https://claude.com/docs/connectors/building/authentication)
- [Claude connectors: add unlisted](https://claude.com/docs/connectors/custom/add-unlisted)
- [Anthropic blog: bringing MCP 2026-07-28 to Claude](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)
- [claude-ai-mcp #1027](https://github.com/anthropics/claude-ai-mcp/issues/1027)
- [claude-ai-mcp #859](https://github.com/anthropics/claude-ai-mcp/issues/859)
- [claude-code #93290](https://github.com/anthropics/claude-code/issues/93290)
- [claude-code #91414](https://github.com/anthropics/claude-code/issues/91414)
- [claude-code #88128](https://github.com/anthropics/claude-code/issues/88128)
- [OpenAI Apps SDK: authentication](https://developers.openai.com/apps-sdk/build/auth)
- [OpenAI developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [kagura-ai memory-cloud #1544 (ChatGPT logs)](https://github.com/kagura-ai/memory-cloud/issues/1544)
- [kanna PR #1258 (ChatGPT logs)](https://github.com/cuongtranba/kanna/pull/1258)
- [Cursor forum: CIMD plans](https://forum.cursor.com/t/mcp-oauth-cimd-support-plans-and-timelines/148096?page=2)
- [Codex PR #38089 (CIMD)](https://github.com/openai/codex/pull/38089)
- [Codex issue #33952 (2026-07-28 flag)](https://github.com/openai/codex/issues/33952)
- [Zuplo MCP compatibility matrix](https://zuplo.com/learn/mcp/compatibility)
- [MCP versioning (legacy × modern fails)](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [TS SDK v2 protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md)
- [Python SDK protocol versions](https://py.sdk.modelcontextprotocol.io/protocol-versions/)
