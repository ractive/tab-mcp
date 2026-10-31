# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/ractive/tab-mcp/security/advisories/new)
(repository → Security → Advisories → Report a vulnerability). Do not open a public
issue, pull request or discussion for a security problem.

In the report, give:

- the package and version (`@ractive-ch/tab-mcp`, `@ractive-ch/tab-mcp-client`, or the
  Docker image tag);
- what an attacker can do, and what they need first;
- steps to reproduce, or a test.

The report stays private between you and the maintainers while it is discussed and
fixed in the advisory.

## Supported versions

Only the newest release of each package gets security fixes; a fix
comes as a new version, not as a patch to an older one.

| Package | Supported | Not supported |
|---|---|---|
| `@ractive-ch/tab-mcp` (npm), `ractive/tab-mcp` and `ghcr.io/ractive/tab-mcp` (Docker) | 0.6.1 | older versions |
| `@ractive-ch/tab-mcp-client` (npm) | 0.10.0 | older versions |

## Connecting an AI app to a page means trusting the page

**Connecting your AI app to a web page means trusting that page, as with any MCP
server.** The page decides which tools exist, how they are described and what they
return. A page can describe a tool in misleading ways, or return text that steers your
AI app into doing something you did not ask for. tab-mcp cannot judge whether a page is
honest.

- Connect only pages you trust. The relay's pairing page names the page's origin (for
  example `https://ractive.ch`) and the AI app that is connecting. Check both before you
  type the code. The origin is what the page's browser reported when it connected; a
  program that is not a browser can claim any origin. It tells you which page you connect
  only when the code comes from a page you opened yourself.
- Type a pairing code only for an AI app you started yourself, and never read the code
  out to anyone.
- If a page says that another tab or program took over its address and you did not open
  it elsewhere, choose "New address": someone may have copied the page's address, and
  your AI apps would talk to them.
- Disconnect AI apps you no longer use, in the page's "Connect your AI app" dialog.

A relay accepts pages only from the origins its operator lists. This keeps other
websites from using a well-known relay's address to look trustworthy. It does not make
a listed page trustworthy.

## What the relay sees

The relay operator can read every tool argument and result, because TLS ends at the
relay. The relay does not log or store them. If you do not want to trust a relay's
operator, run your own relay: see [self-hosting](docs/self-hosting.md).

## More

- [Threat model](docs/threat-model.md): assets, attackers, mitigations and the risks that
  remain.
- [Configuration](docs/configuration.md): the safe defaults and the open-relay warning.
