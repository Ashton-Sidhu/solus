# MCP sign-in: one callback

Status: decided and built (November 2026).

## Problem

The host built an MCP sign-in's redirect URI from the origin the client reached the host on, plus a route of the Solus server: `${origin}/oauth/integration/callback`. That joined three facts that change apart:

1. Where the browser that signs in runs (a transport fact: `127.0.0.1:3001`, a LAN address, a tailnet name).
2. A route name of the Solus server.
3. The client's public identity. Vendor allowlists, organization allowlists (Atlassian's Rovo MCP server), Solus's Client ID Metadata Document, and every OAuth app an owner creates match the redirect URI as an exact string.

The third must be stable and conventional. Servers that accept only the callbacks of known clients refused Solus. HiddenLayer's server (`api.us.hiddenlayer.ai/mcp`) registers clients dynamically, but accepts only a loopback callback with the path `/` or `/callback`, and claude.ai's. It refused `http://127.0.0.1:3001/oauth/integration/callback` at registration and at authorization.

## Decisions

1. **One loopback callback.** `http://127.0.0.1:51790/callback` (`INTEGRATION_OAUTH_LOOPBACK_URL` in `packages/contracts/src/integrations/oauth-callback.ts`). `/callback` on a loopback IP is the shape native clients use (RFC 8252 §7.3), and the shape servers that allow "the CLI clients" accept. The port is fixed because most servers and the metadata document compare the full string, port included.
2. **A listener of its own.** `IntegrationOAuth` owns a loopback-only listener (`integrations/oauth-loopback.ts`), apart from the Solus server, so it takes no route of the web client and is never reachable from the network. It listens only while a sign-in waits on it, like the Atlassian sign-in. When the port is in use, a server that registers Solus dynamically gets a port the system picks; an exact-match client (the document, an owner's app) is refused with a plain message.
3. **The browser's place decides, not the origin alone.**
   - A browser on the host (the client reached the host on loopback) returns to the loopback callback.
   - A browser on another device that reaches the host on its origin returns to the host route there, as before. A signed-in person's sign-in runs at Solus Cloud, as before.
   - A browser that cannot reach the host gets the loopback callback, and the person pastes the address the browser lands on.
4. **The client reads the URL; it does not build it.** The clients show `INTEGRATION_OAUTH_LOOPBACK_URL` for an owner's OAuth app and in the setup hand-off. No client derives a redirect URL from its own origin.
5. **An owner's app keeps its redirect.** A new owner client is saved with the loopback callback, and every sign-in with it sends that URL (from another device, with the paste). A client saved before this decision has no saved redirect and keeps the host route, so no app an owner registered breaks.
6. **The server's client ID is kept.** When Solus registers itself, the record keeps the public client ID the server gave it (`auth.registeredClientId`). Some servers give every client one static ID (HiddenLayer's). The owner's client form starts from the owner's own ID, else from this one, so nobody has to find and type it (`IntegrationLabels.startingClientId`). Solus registers when a server that offers registration is added, for the loopback callback, so the ID is on the record before the sign-in step shows; the sign-in from the host reuses that registration. A refusal at the add is not an error: the sign-in meets it again and says so.
7. **Publish before switching.** `solus-client-metadata.json` names the new callback next to the old ones; older hosts still send the old ones. The document is published from the site (`apps/site`, `/oauth/client-metadata.json`) before hosts with this change ship. Until a host reads the new document, it registers dynamically.

## Not done, on purpose

- No retry with `/callback` after a refusal: that gives a client two identities, chosen by a guess.
- No list of vendors' static client IDs. HiddenLayer's registration returns its one static ID by itself once the callback is accepted.
- No `/callback` route on the Solus server: the web client owns the server's root.
