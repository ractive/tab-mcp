---
type: research
title: "Feedback from integrating tab-mcp into comparis 2027"
description: Bugs, rough edges and developer-experience gaps found while adding the React client 0.9.1 to a Vite + React 19 + Tailwind v4 game and testing it against the 0.6.0 relay.
tags:
  - client
  - react
  - feedback
timestamp: 2026-10-31T21:00:00+01:00
---

# tab-mcp: feedback from integrating it into comparis 2027

Notes from adding `@ractive-ch/tab-mcp-client` 0.9.1 (React) to a Vite + React 19 + Tailwind v4 game, and testing it against `ractive/tab-mcp:0.6.0` in Docker and the in-process test relay. Roughly ordered by how much each one cost.

## Bugs and rough edges

1. **The connect dialog loses its centring under Tailwind v4 (and other CSS resets).**
   Tailwind's preflight sets `margin: 0` on everything. The dialog's stylesheet does not set its own margin, so the browser's `margin: auto` for modal dialogs is gone and the dialog sticks to the top-left corner.
   *Workaround here:* `dialog[class*='tab-mcp'] { margin: auto; }`.
   *Suggestion:* set `margin: auto` (and ideally `inset: 0`) on the dialog in the built-in stylesheet, so pages with a reset do not have to know about it.

2. **The address host can differ from the relay URL the page was configured with.**
   With the in-process test relay at `http://127.0.0.1:8790`, the dialog showed `http://localhost:8790/a/…/mcp`. It worked, but it is surprising, and on machines where `localhost` resolves to `::1` first it may not.
   *Suggestion:* derive the address from the configured public URL consistently, or document which one wins.

3. **"Reconnecting…" forever when the relay goes away.**
   After stopping the relay, the button showed "Reconnecting…" indefinitely. The game kept working, which is good, but the player gets no hint that the AI app connection is gone for good and no way to stop trying.
   *Suggestion:* after a few attempts, show "Connection lost" with a retry action, or expose an attempt count or next-retry time in `useTabMcpState()` so pages can show it.

## Developer experience

4. **No published test helpers.**
   `startRelay`, `tokenFor` and `connectClient` live in `packages/tab-mcp-client/test/helpers.ts`, which is not in the npm package. To test the game's tools end to end I imported them from a local clone of the repository.
   *Suggestion:* publish them as `@ractive-ch/tab-mcp/testing` (an in-process relay plus a token helper), like `@comparis/neon-shell/testing`.
   *Answer (2026-10-31):* accepted. `startRelay` and `tokenFor` will be published in `@ractive-ch/tab-mcp/testing`; that export exists but today only has the token store conformance suite. Until it ships, keep importing from a local clone.

5. **There is no way to pair from a script against a real relay.**
   `tokenFor` writes into the relay's token store, which only works in-process. Against the Docker relay, pairing needs the browser `/authorize` page and a human typing the code.
   *Suggestion:* a development-only pairing endpoint or a small CLI (`tab-mcp pair <address> <code>` that prints a token) for CI and local scripts.
   *Answer (2026-10-31):* declined. Such an endpoint would issue tokens outside the OAuth flow: no AI app (no CIMD client ID), no consent screen, no PKCE, and no binding for refresh, revocation or `private_key_jwt`. It would be a second token issuer in the production image, switched on by one setting; one misconfiguration and anyone who sees a pairing code gets a token tied to no app. Instead: automated end-to-end tests use the in-process relay with `tokenFor` (item 4); against the Docker relay, pair by hand through `/authorize`. A script that drives the real OAuth flow is possible but not built yet. It would need:
   - an https client metadata document with a loopback `http://127.0.0.1` redirect;
   - to read the code from the `pairingcode` event;
   - to post it with the `/authorize` page's CSRF token;
   - to exchange it with PKCE.
   Build it only if pairing from a script against a deployed relay is really needed.

6. **`connect()` must come from a user action, which also blocks browser automation.**
   A scripted `button.click()` (from tests or automation tools) shows "Could not connect: connect() must be called from a user action". That is a sensible safety rule, but it is not mentioned near `ConnectButton`, and it cost time while testing.
   *Suggestion:* document it next to `ConnectButton` and `showConnectDialog`, and consider allowing scripted connects when the relay runs in development mode.
   *Answer (2026-10-31):* the rule stays. A real click through Playwright or CDP (`page.click`, `locator.click`) has user activation and works; only a scripted `element.click()` lacks it. Otherwise call `mcp.connect({ resume: true })`, which skips the user-action check.

7. **Tools that change React state need a pattern.**
   The React example keeps its data in an external store, so a tool can change it and return the new state synchronously. In an app that keeps its state in `useState`, a tool that applies an action and returns the result has to use a ref and `flushSync`. It works, but it took some thinking.
   *Suggestion:* a short "tools in a `useState` app" section in the README with the ref plus `flushSync` pattern, or a `useTool` option that runs `execute` after the next commit.

8. **Tool inputs are untyped.**
   `execute` receives `Record<string, unknown>`, so every tool casts its arguments.
   *Suggestion:* a generic `useTool<Input>()`, or inference from a `const` JSON Schema (`json-schema-to-ts` style).

9. **Custom button labels per state.**
   `ConnectButton` takes children as a fixed label. To show "Claude is playing" when connected, the page reads `useTabMcpState()` and computes the label itself.
   *Suggestion:* a `label={(state) => …}` prop.

## Hosting

10. **How does a page get onto the hosted relay's allowed origins?**
    `tab-mcp.ractive.ch` rejects origins it does not know ("Could not connect to the relay (refused, unreachable, or this page's origin is not allowed)"). The message is clear, but the README does not say how a project gets its origin allowed, or whether the hosted relay is meant for third-party pages at all.
    *Suggestion:* one paragraph in the README: who can use the hosted relay, and how to ask.
    *Status (2026-10-31):* `https://comparis-the-game.b-cdn.net` is being added to `tab-mcp.ractive.ch`'s allowed origins in ractive.ch PR #73. The relay refuses the origin until that PR is merged and applied.

## Worked well

- The theming custom properties (`--tab-mcp-font`, `--tab-mcp-accent`, `--tab-mcp-radius`, …) made it easy to match the comparis look.
- `useTool` with `execute` always reading the latest closure was easy to use.
- The game kept running normally while the relay was down, and the console stayed clean.
- An end-to-end test (real relay, page in the browser, MCP SDK client) listed and called all nine tools without problems.

## Not tab-mcp, but found on the way

- **TypeSafe SDK (`@typesafe-ai/sdk` 0.7.0) under Bun 1.4.4:** every `systemOne` call fails with `TypeError: Body already used`. The same code works under Node 24. The game's server therefore runs on Node.
