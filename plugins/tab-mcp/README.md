# tab-mcp agent skill

An [Agent Skill](https://agentskills.io/specification) that teaches a coding agent to add
tab-mcp to a web app: install `@ractive-ch/tab-mcp-client`, register tools, set up the
connect and pairing flow, confirm consequential tools, keep the security defaults and
run a tab-mcp relay. The skill is [`skills/tab-mcp/SKILL.md`](skills/tab-mcp/SKILL.md).

This folder is a plugin for Claude Code and Codex. The repository root holds the
marketplace files that point here.

## Claude Code

```text
/plugin marketplace add ractive/tab-mcp
/plugin install tab-mcp@tab-mcp
```

The first command reads `.claude-plugin/marketplace.json` from the repository; the
second installs the plugin from `plugins/tab-mcp`. From a local clone, use the path
instead of `ractive/tab-mcp`. On the command line the same is
`claude plugin marketplace add ractive/tab-mcp` and
`claude plugin install tab-mcp@tab-mcp`.

## Codex

From a clone of the repository:

```sh
codex plugin marketplace add .
codex plugin add tab-mcp@tab-mcp
```

The marketplace is `.agents/plugins/marketplace.json`; the plugin manifest is
`.codex-plugin/plugin.json`. Codex shows the skill as "tab-mcp" (from
`skills/tab-mcp/agents/openai.yaml`); ask for it with `$tab-mcp`.

## claude.ai

claude.ai takes skills as a ZIP upload. From a clone of the repository, make a ZIP file
whose top level is the skill folder:

```sh
cd plugins/tab-mcp/skills
zip -r tab-mcp-skill.zip tab-mcp
```

Then open the skills settings in claude.ai (under Customize), upload
`tab-mcp-skill.zip` as a new skill and turn it on. Skills need code execution to be
turned on in claude.ai. Skills you turn on there are also available in Claude Code
sessions signed in with the same account.

## Other agents

Any agent that reads Agent Skills can use the folder `skills/tab-mcp` as is. Copy it
into the agent's skills directory, for example `.claude/skills/tab-mcp` or
`.agents/skills/tab-mcp` in your project.

## Versions

The plugin version follows the packages it describes (`0.7.0`). Update the
skill and both `plugin.json` files, and the version in `.claude-plugin/marketplace.json`,
when the client or relay API changes.
