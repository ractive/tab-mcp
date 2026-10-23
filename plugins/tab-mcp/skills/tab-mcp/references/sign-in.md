# Sign-in instead of a code

On a relay that pairs by `oidc` (identity binding), the
user signs in to the AI app's connection with the account they use on the page and no
code is shown. Give the library `identityAssertion: async ({ address }) => …`, which asks
your backend for a short-lived tab assertion of the signed-in user for that address
(`null` when nobody is signed in); call `mcp.signOut()` in your logout and
`mcp.refreshIdentity()` after a sign-in without a reload. `identity` (`none`, `pending`,
`bound`, `refused`) and the event `identitychange` say whether the relay accepted it.
The relay's configuration: [identity binding](https://github.com/ractive/tab-mcp/blob/main/docs/configuration.md#identity-binding).
