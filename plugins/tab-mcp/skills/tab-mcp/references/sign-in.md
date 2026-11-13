# Sign-in instead of a code

On a relay that pairs by `oidc` (identity binding), the
user signs in to the AI app's connection with the account they use on the page and no
code is shown. Give the library `identityAssertion: async ({ address }) => …`, which asks
your backend for a short-lived tab assertion of the signed-in user for that address
(`null` when nobody is signed in); call `mcp.signOut()` in your logout and
`mcp.refreshIdentity()` after a sign-in without a reload. `identity` (`none`, `pending`,
`bound`, `refused`) and the event `identitychange` say whether the relay accepted it.
The relay's configuration: [identity binding](https://github.com/ractive/tab-mcp/blob/main/docs/configuration.md#identity-binding).

The backend signs for the user of its own session (its session cookie), and only for an
`address` of your relay. Do not take an ID token or another bearer credential from the
page per request and sign for whoever it names: a program sends any `Origin`, so an
Origin check does not stop it, and whoever holds a user's ID token (an hour, also after
sign-out) would get assertions naming that user. The live sign-in example
(<https://tab-mcp-login.ractive.ch/>) takes Google's ID token from the page because it has
no backend session; it is not the pattern for a real web app. `identityAssertion` must
answer within 15 s (`identityTimeoutMs`), including any sign-in prompt it waits for.
