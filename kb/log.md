# Log

## 2026-10-19

- Security review of PR #4: eight findings fixed, DEC-061 to DEC-067
- Iteration 3 built on iter-3/oauth: OAuth authorization server with pairing codes and sites, DEC-056 to DEC-060; real-browser check with Claude Code's metadata document
- Review of PR #3: release guards (main-only bootstrap, commits on main, tarball hash, signer check, latest never backwards), owner steps reordered, latest known issue
- Iteration 5a: npm release workflow for @ractive-ch/tab-mcp-client 0.1.0-alpha.0 (bootstrap proven on the branch), npm publishing steps, DEC-055 (release tags and dist-tags)
- Iteration 2: browser library built; DEC-049 (own MCP subset after measuring the SDK) to DEC-054
- Review of PR #1 fixed: DEC-047 (crash logging), DEC-048 (body-read deadline), Bun idle-timeout finding
- Iteration 1 implemented on iter-1/relay-core; DEC-040 order and relay error codes documented
- One relay serves several sites: app name from the tab, per-origin site configuration (DEC-045)
- Iteration 6: OpenTofu state in a bunny storage zone over S3 with client-side encryption (DEC-044)
- Iteration 6: hosted relay as infrastructure as code with OpenTofu and the BunnyWay/bunnynet provider (DEC-043), with research items
- Identity binding planned for 0.2+ (design, iteration 7, research list); pairing becomes a replaceable method in iteration 3 (DEC-042)
- Owner decisions DEC-027 to DEC-038 recorded (plus DEC-039 to DEC-041); open questions closed; design docs and iteration plans adjusted
- Initial plan: research notes, architecture, protocol, threat model, decision log, six iterations, open questions, release credentials
