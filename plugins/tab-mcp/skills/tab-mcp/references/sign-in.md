# Sign-in instead of a code

On a relay that pairs by `oidc` (identity binding), the
user signs in to the AI app's connection with the account they use on the page and no
code is shown. Give the library `identityAssertion: async ({ address }) => …`, which asks
your backend for a short-lived tab assertion of the signed-in user for that address
(`null` when nobody is signed in); call `mcp.signOut()` in your logout (it resolves once the relay removed the grants) and
`mcp.refreshIdentity()` after a sign-in without a reload (it resolves with the new
`identity`); both reject with an `InvalidStateError` while the page is not connected. `identity` (`none`, `pending`,
`bound`, `refused`) and the event `identitychange` say whether the relay accepted it.
A sign-in pairs the page only while its "Connect your AI app" dialog is open, and with
relays after 0.12.1 for at most 10 minutes after the user opened it: `pairingUntil` (event
`pairinguntil`) says until when. The library's dialog shows the time and then a
Continue button; a custom UI calls `startPairing()` again only from such a click, never
from a timer. A reconnect does not start the 10 minutes again.
The relay's configuration: [identity binding](https://github.com/ractive/tab-mcp/blob/main/docs/configuration.md#identity-binding).

The backend signs for the user of its own session (its session cookie), and only for an
`address` of your relay. Do not take an ID token or another bearer credential from the
page per request and sign for whoever it names: a program sends any `Origin`, so an
Origin check does not stop it, and whoever holds a user's ID token (an hour, also after
sign-out) would get assertions naming that user. The live sign-in example
(<https://tab-mcp-login.ractive.ch/>) takes Google's ID token from the page because it has
no backend session; it is not the pattern for a real web app. `identityAssertion` must
answer within 15 s, including any sign-in prompt it waits for.
