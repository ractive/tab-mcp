# Docs agent (Claude Managed Agent)

The agent that wrote the iteration 5 documentation and developer skill (session
`sesn_015YTUw7zutBUuNRAzGRmgho`, 2026-10-20, $9.42). It runs on Anthropic's servers on the
owner's API org. The repository is mounted read-only without a token; the agent hands its
work back as a git bundle (`/mnt/session/outputs/*.bundle`) plus `REPORT.md`, and a person
applies the bundle on a branch and opens the pull request.

- `agents/tab-mcp-docs-writer.md`: the agent; the body is the system prompt.
- `environments/tab-mcp-docs.yaml`: npm registries plus three documentation sites.
- `task.md`, `rubric.md`: the outcome and its grader rubric; edit both for a new task.
- `run.sh`: uploads `writing-style.md` (a copy of saturnus `kb/docs/writing-style.md`),
  mounts tab-mcp and hyalo, starts one session with a $60 budget, prints its id.
- `claude-lock.json`: ids written by `ant apply`.

Use the `ant` profile `wiki-audit` only through `ANTHROPIC_PROFILE=wiki-audit` (see
saturnus `tools/wiki-audit/README.md`); keep `default` the active profile.

```sh
export ANTHROPIC_PROFILE=wiki-audit; unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
SID=$(./run.sh)
ant beta:sessions retrieve --session-id "$SID" --transform '{status,outcome_evaluations,usage}'
ant beta:files list --scope-id "$SID" --beta managed-agents-2026-04-01 --transform '{id,filename}'
ant beta:files download --file-id <id> --output out.bundle </dev/null
git fetch out.bundle <branch>:<branch>
```
