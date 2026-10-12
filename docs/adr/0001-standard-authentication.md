# ADR 0001 — Standard authentication for accounts, clients, and hosts

Status: ACCEPTED, 2026-10-09. Supersedes plan 010 §2.4 (8-hour first-party
tokens), §3 (desktop sign-in through the device grant), and the "unchanged" list of
§4 for signed-in use. Plan 010's roles (§3) stay; this ADR makes the code meet them.

## 1. Context

Plan 010 made app.solus.sh an OAuth 2.1 and OpenID Connect provider. The code
meets that plan only in part. An audit (2026-10-09) found about 22 credential
types in the two repositories, and these defects:

- Sign-in gives a client the raw Better Auth session token (device grant), not
  OAuth tokens. There is no PKCE, no ID token, and no `/userinfo`. The profile
  comes from a custom route, `/api/account/me`.
- A custom route mints first-party access tokens as a fake `authorization_code`
  grant (`solus-cloud/src/lib/server/auth/oauth.ts`). They live 8 hours and
  cannot be revoked.
- Sign-out clears a local cache. It does not revoke a token that a host holds.
  Delegated refresh tokens are not bound to a session and live 100 years.
- Delegations exist only for organizations. The owner of a personal host has no
  delegation, so the desktop passes the owner's token through a side path
  (`ownerAccessToken`), and a VM host has no path at all.
- The desktop renderer opens its own host with a host-issued HMAC session token,
  kept in plaintext. It does not use the account.
- A host resolves "a person's token" in four places. It forwards a client's
  host-audience token to the cloud in a JSON body.
- A host holds three credentials (host token, client secret, tunnel token), and
  keeps its own revocation list that the cloud never sees.

Each defect looked local. Together they show that the system has no single
model. This ADR sets one.

## 2. Decision

Solus uses standard OAuth 2.1 and OpenID Connect, and nothing custom where a
standard exists.

### 2.1 Words

| Word | Meaning |
|---|---|
| **account** | A person at app.solus.sh. |
| **client** | One install of desktop, mobile, web, or the CLI. A public OAuth client. |
| **client grant** | One sign-in of one client: its refresh-token family. Its id is `grant_id`. |
| **access token** | A JWT (RFC 9068) for one resource: a host, the Solus API, or the account plane. Life: 5 minutes. |
| **host** | A machine that runs the Solus server. A resource server and a confidential OAuth client. |
| **host credential** | The one key a host holds to prove that it is that host (`private_key_jwt`). |
| **service credential** | The same kind of key, held by the Solus API. |
| **delegation** | Tokens that a host holds to act for a person, made by token exchange from one client grant. |
| **local access** | Access that needs no account: pairing (a client or another host pairs with a host) and host session tokens. It works offline and signed out, and in the same way when signed in. |

### 2.2 Rules

1. **One sign-in per client.** Desktop and mobile use authorization code + PKCE
   through the system browser (RFC 8252: loopback redirect on desktop, a claimed
   scheme on mobile). The web client signs in only on the account origin
   (app.solus.sh), as today. On any other origin (a host, a tunnel, a self-hosted
   server) it uses local access only, as today. The CLI uses the device grant, and the
   grant gives OAuth tokens, never a session token.
2. **Identity is OIDC.** The ID token and `/userinfo` give `sub`, `email`,
   `email_verified`, `name`, and `picture`. Organizations are API data
   (`GET /v1/account`), not identity.
3. **Access tokens are short and have one audience.** The client gets each one with
   its refresh token and `resource` (RFC 8707). Life: 5 minutes. Nobody forwards an
   access token to a different audience.
4. **A socket does not close when its token ends.** The client sends the next token
   on the open socket (`auth.renew`). The host closes the socket only when no valid
   token comes.
5. **Sign-out ends one client grant.** The client revokes its refresh token
   (RFC 7009). The cloud marks the grant revoked. Every delegation made from that
   grant fails at its next refresh. Other clients of the same person continue.
   Signing out of the website ends only the website's browser session.
6. **A host acts for a person only through a delegation.** The host exchanges the
   client's access token for that host (RFC 8693). The delegation carries the
   client grant's `grant_id`, and the cloud refuses it when that grant is revoked. It is
   the same path for the owner and for a member. The scope is one organization or
   `personal`.
7. **Every call to the account plane for a person uses a delegated access token as
   `Authorization: Bearer`.** This is true for a host, a managed host, and the Solus
   API. No token goes in a body. No host token or service key goes beside it.
8. **A host has one credential.** It is a key pair registered at link time
   (`private_key_jwt`, RFC 7523). The host gets its own access tokens with the
   client credentials grant to manage its link. The tunnel token stays, because it
   is infrastructure and not identity.
9. **Unlink removes the host credential, and only that.** The host's client and
   its delegations go. No account and no client grant changes.
10. **The account adds reach; it never gates local access.** The desktop window
    opens its own host, and a paired client or paired host opens a host, with local
    access, signed in or not, online or offline. Signing in adds what only the account
    can give: account reads for the owner (through a delegation that the signed-in
    desktop presents to its host), and reach to hosts that are not paired. A paired
    host is always reached by pairing (cross-host-sessions §10.3 decision 1).
    Signing out removes only what the account added.
11. **One revocation authority for each kind of access.** The cloud revokes account
    grants. A host revokes its local access (paired devices and paired hosts), and its
    owner may also refuse one account grant on that host (the Access tab).

### 2.3 What goes

The custom mint route `POST /v1/hosts/[hostId]/access-token`; `/api/account/me`;
the device grant that returns a session token (desktop and mobile);
`HostGrantCache`; 8-hour tokens; `ownerAccessToken`, `ownerHosts`, `useOwnerToken`,
`useDelegatedTokens`, `rememberPersonToken`, `personAccessToken`,
`ownPersonToken`; the host token `sht_` and the client secret `shc_` (replaced by
the host credential); the body `accessToken` on executor routes; the
service-key path for connection credentials; guest grant JWTs (dead code).

What stays: WebSocket tickets (a browser cannot set headers on a socket), signed
asset URLs, share links, local access (pairing and host session tokens), and the
tunnel token.

## 3. Interfaces

### 3.1 Contracts (`packages/contracts`)

```ts
// auth/clients.ts (new)
export const SOLUS_CLIENT_IDS = { desktop: 'solus-desktop', mobile: 'solus-mobile', web: 'solus-web', cli: 'solus-cli' } as const
export const SIGN_IN_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const
export const ACCESS_TOKEN_TTL_SECONDS = 300

/** What one access token is for (RFC 8707 `resource`). */
export type TokenResource =
  | { kind: 'host'; hostId: string }   // hostAudience(hostId)
  | { kind: 'api' }                    // SOLUS_API_AUDIENCE
  | { kind: 'account' }                // ACCOUNT_AUDIENCE

/** OIDC standard claims: the only identity a client reads. */
export interface AccountIdentity {
  sub: string
  email: string
  emailVerified: boolean
  name: string | null
  picture: string | null
}
```

```ts
// account-types.ts (changed)
// `AccountProfile` is replaced by `AccountIdentity`.
export type AccountState =
  | { kind: 'signed-out' }
  | { kind: 'signing-in'; authorizeUrl: string }          // browser flow; the CLI keeps its user code
  | { kind: 'signed-in'; identity: AccountIdentity; consoleUrl: string; signedInAt: number; isStale: boolean }
  | { kind: 'invalid'; reason: 'revoked' | 'expired' | 'unreachable' }
  | { kind: 'unavailable'; reason: 'encryption' }
```

```ts
// uplink.ts (changed): access token claims
accessTokenClaimsSchema = z.object({
  iss, aud, sub, jti, iat, exp, client_id,
  grant_id: z.string().min(1),   // the client grant; replaces `deviceId`. `sid` stays the provider's Better Auth session
  act: tokenActorSchema.optional(), // present on a delegated token
  scope: z.string().optional(),
  // Solus claims stay: access, hostKind, organizationId, organizationRole, teamIds, hostCategory, hostOwnerUserId
})
// Removed: hostAccessTokenResponseSchema, guest grant claims, GUEST_GRANT_TTL_SECONDS.
```

```ts
// rpc.ts (new method on every host)
authRenew(request: { accessToken: string }): Promise<{ expiresAt: number }>
// The token must have the same `sub` and `aud` as the socket's principal.
```

### 3.2 Client core (`packages/client-core`)

```ts
// oauth-session.ts (new): one implementation for desktop main, mobile, and web
export interface OAuthSession {
  state(): AccountState
  onChange(listener: (state: AccountState) => void): () => void
  signIn(): Promise<'approved' | 'denied' | 'cancelled' | 'error'>
  /** Revokes this client's refresh token (RFC 7009), then clears the store. */
  signOut(): Promise<void>
  /** A valid access token for one resource, by refresh grant; cached until 60 s before its end. */
  accessToken(resource: TokenResource): Promise<string | null>
  /** Reads `/userinfo` again; the ID token is the first source. */
  refreshIdentity(): Promise<void>
}

/** The platform part: how the browser step runs. */
export interface BrowserAuthorizer {
  /** Opens `authorizeUrl` and resolves with the callback URL, or null when the person closed it. */
  authorize(authorizeUrl: URL, redirectUri: string): Promise<URL | null>
  redirectUri(): string   // desktop: http://127.0.0.1:<port>/callback; mobile: solus://auth/callback; web: <origin>/auth/callback
}

/** The platform part: where the refresh token lives. */
export interface TokenStore {
  load(): StoredGrant | null
  save(grant: StoredGrant): void
  clear(): void
}
export interface StoredGrant { refreshToken: string; idToken: string; identity: AccountIdentity; signedInAt: number }
```

Replaced by `OAuthSession`: `HostGrantCache`, `CloudAccount.readProfile`,
`profileFromResponse`, `device-authorization.ts` (it stays for the CLI only),
`cookieCloudAccount`'s sign-in probe. `CloudAccount` keeps its API calls and takes
its token from `OAuthSession.accessToken({ kind: 'account' })`.

### 3.3 Desktop (`apps/desktop`)

```ts
// account/account-session.ts (changed): a thin wrapper
class AccountSession {
  constructor(deps: { oauth: OAuthSession })
  current(): AccountState
  signIn(): Promise<'approved' | 'denied' | 'cancelled' | 'error'>
  signOut(): Promise<void>
  accessToken(resource: TokenResource): Promise<string | null>   // replaces acquireHostAccessToken and cloudRequest's token
}
// Removed: `ownerAccessToken` and `ownerHosts` boot options; the plaintext `local-session-token.json` (stage 6, §5).
```

The renderer opens the local host with `accessToken({ kind: 'host', hostId })`
through the normal WebSocket ticket. It uses a host session token only in local
mode.

### 3.4 Host server (`packages/server`)

```ts
// host/host-credential.ts (new): replaces the host token and the client secret
export interface HostCredential {
  readonly clientId: string
  /** A signed client assertion (RFC 7523) for the token endpoint. */
  assertion(audience: string): Promise<string>
  /** The host's own access token (client credentials grant), for link management. */
  hostAccessToken(): Promise<string>
}
```

```ts
// sync/delegations.ts (changed)
export type DelegationScope = { organizationId: string } | 'personal'
export type DelegationRefusal = 'GRANT_REVOKED' | 'ORGANIZATION_ACCESS_REFUSED' | 'ACCOUNT_UNAVAILABLE' | 'AUTHORITY_MISSING'

export class Delegations {
  /** Token exchange with a client's access token for this host; keeps the delegation for (sub, scope), bound to its `grant_id`. */
  establish(subjectToken: string, scope: DelegationScope): Promise<void>
  has(userId: string, scope: DelegationScope): boolean
  /** A delegated access token for one resource; refreshes; refusal ends the person's work in that scope. */
  accessToken(userId: string, scope: DelegationScope, resource: TokenResource): Promise<string>
  apiClient(userId: string, scope: DelegationScope): SolusApiClient
  holders(): Array<{ userId: string; scope: DelegationScope }>
  forget(userId: string, scope: DelegationScope): void
  clear(): void
}
// Removed from deps: `personToken`. A delegation is made only from a token a client presented.
```

```ts
// vault/account-reads.ts (new): replaces vault/account-integrations.ts
/** Every account read for a person goes here: a delegated token, as Bearer. */
export interface AccountReads {
  fetch(userId: string, scope: DelegationScope, path: string, init?: RequestInit): Promise<Response | null>
}
```

Callers that change to `AccountReads`: the agent profile pull
(`execution/seats/agent-profile.ts`), `CloudIntegrationCredentials`,
`accountIntegrationCredential` (GitHub, Google, Atlassian), and the cross-host
directory read. The socket gains `authRenew` (`transport/websocket.ts`).
`admission/auth.ts` keeps `revokeDevice` for local-mode devices only.

### 3.5 Cloud (`solus-cloud`)

- Better Auth `oauth-provider`: register `solus-desktop`, `solus-mobile`,
  `solus-web`, and `solus-cli` as public clients. Turn on authorization code +
  PKCE, refresh with `resource`, ID tokens, `/userinfo`, revocation, and the device
  grant for `solus-cli`. Turn on `enforcePerClientResources`.
- The grant id is the refresh token's `referenceId`, which the provider carries
  through every rotation and passes to the access-token claims hook. Code flow:
  `postLogin.consentReferenceId` returns a new grant id for each sign-in. The
  claims hook emits it as `grant_id` (the provider already uses `sid` for the
  Better Auth session). A grant is alive while one of its refresh tokens is not
  revoked. `/oauth2/revoke` revokes it.
  `consentReferenceId` receives no client, so it gives a grant id to every
  authorization-code sign-in. Only the Solus clients use that flow (dynamic
  registration is off), and the claims hook emits `grant_id` only for a Solus
  client. A host client's `referenceId` stays its organization.
- The CLI's device grant is a small grant at the token endpoint
  (`auth/sign-in-clients.ts`). It uses the device-authorization plugin's codes and
  approval, and issues OAuth tokens with a new grant id. The provider's
  `oauthDeviceAuthorization()` is not used: it cannot run beside the plugin that
  still gives desktop and mobile a session token, and it sets no `referenceId`.
- The four clients are rows that the server writes at each start. Desktop:
  `http://127.0.0.1/callback`; the provider lets only the port of an `http`
  loopback redirect change (RFC 8252 §7.3), so the app can listen on any free port.
  Mobile: `solus://auth/callback`. Web: `<appOrigin>/auth/callback`. CLI: no
  redirect. All skip consent and require PKCE.
- Each host is an `oauthResource` row, written when the host is linked
  (`registerHostResource`, called from `activateLink`).
- Token exchange (`auth/token-exchange.ts`): copy `grant_id` from the subject token;
  allow `personal` scope for the host's owner; refuse issue and refresh when the
  grant is revoked; `private_key_jwt` for host clients.
- The Solus API is a confidential client with `private_key_jwt`, as a host is. It
  reads a person's connections by token exchange with the person's API token as
  the subject, through the same `Delegations` class as a host. `INTEGRATION_SERVICE_KEY`
  and `SOLUS_INTEGRATION_SERVICE_KEY` go.
- Executor routes (`/v1/agent-profile/read`, `/v1/agent-profile/credential`,
  `/v1/integrations/[provider]/credential`) take only
  `Authorization: Bearer <delegated token>` with audience `ACCOUNT_AUDIENCE`.
  `delegatedUser` becomes "verify the bearer and its grant".
- Devices page: list a person's client grants and host delegations, and revoke one.
- Delete: `oauth.ts` mint and `/v1/hosts/[hostId]/access-token`,
  `/api/account/me`, guest grants, the service-key credential path, `shc_`, `sht_`.

## 4. Consequences

- Sign-out, unlink, and organization removal each have one effect, and a person
  can see and end each grant on the Devices page.
- The owner and a member use the same path, so the owner of a VM host has unattended
  delegations while a client grant of theirs is alive.
- Every client gets identity from the same standard source.
- A socket needs `auth.renew` every 5 minutes; a client that sleeps longer
  reconnects.
- No compatibility. Solus and solus-cloud release together. Each client signs in
  again, and each host links again.

## 5. Better Auth support (checked, `@better-auth/oauth-provider` 1.7.6)

| Need | Support |
|---|---|
| Authorization code + PKCE for public clients | Yes (`/oauth2/authorize`, `/oauth2/token`). |
| ID token, `/oauth2/userinfo`, `/oauth2/end-session` | Yes. Back-channel logout also exists. |
| Revocation (RFC 7009) | Yes (`/oauth2/revoke`). It marks the refresh token revoked and deletes its access tokens. |
| Refresh with `resource` (RFC 8707) | Yes, with one limit: a refresh can only narrow to the resources of the sign-in. So a client signs in with no `resource`, and each host is registered as an `oauthResource` row at link time. Each resource can set its own access-token life. |
| `private_key_jwt` (RFC 7523) | Yes. The client must register `jwks` or `jwks_uri`. |
| Device grant that gives OAuth tokens | Yes (`urn:ietf:params:oauth:grant-type:device_code` through the provider, not the plugin's `/device/token`). |
| A grant id through rotation | Yes, through `referenceId` (§3.5). The provider's device grant sets no `referenceId`, so the CLI uses our own device grant at the token endpoint (§3.5). |
| Loopback redirect on any port (RFC 8252) | Yes. Register `http://127.0.0.1/callback`; a request may change only the port. An `https` loopback address is refused. |
| Identity in the ID token | Not by default: the provider gives `email`, `name`, and `picture` only at `/userinfo`. `customIdTokenClaims` adds them to the ID token by scope. |
| Audience of a refreshed token | When the refresh keeps `openid`, `aud` is the resource and the `/oauth2/userinfo` address. A refresh with a narrower `scope` (no `openid`) gives only the resource. |

Stage 1a (2026-10-09) leaves two settings for stage 2, because the first-party mint
uses the same resource rows until stage 2 deletes it (stage 1c-ii sets both, below):

- **Token life.** The provider's default access-token life is 300 s, so a Solus
  client's token lives 5 minutes. No resource row sets its own life: a row's life
  also limits the mint's 8-hour tokens.
- **Who may get a token for a host.** `enforcePerClientResources` stays off. It
  links clients to resources, not people to hosts, and all installs share one
  client id, so it does not stop a person from asking for a token for a host that
  they cannot reach. Stage 2 must refuse that at issuance (the access-token claims
  hook can refuse). Stage 1b does this (§7).

Stage 1b (2026-10-09) made these decisions where the text above was not exact:

- **Claims schema.** `grant_id` and `organizations` are optional, and `deviceId` is
  optional too, because the old mint still issues `deviceId` and one
  `organizationId`. A host refuses a token that has neither `grant_id` nor
  `deviceId`. Stage 1c removes `deviceId` and makes `grant_id` required.
- **Reach.** One function, `hostReach` (`solus-cloud` `auth/host-access.ts`), decides
  who reaches a host and through which organizations. The claims hook and the old
  mint both call it. The hook refuses a token for a host that the person cannot
  reach or that is not linked (`invalid_target`), and for a member whose every
  organization refuses personal computers (`access_denied`). A refused refresh
  rotates nothing. A Solus API token lists all memberships; a person with none gets
  no token. A request that names more than one resource gets no token.
- **Account routes.** A `/v1` request with no session that carries a Solus client's
  access token for `ACCOUNT_AUDIENCE` is accepted when its grant is alive
  (`isGrantAlive`: one refresh token with that `referenceId` is not revoked). Such a
  caller has no `sessionId`, so the old mint route and the Connections page refuse
  it. `/api/account/*` does not take the token, because stage 1c deletes it.
- **Organization in a connection.** The WebSocket ticket request and the Solus API
  credential request (`POST /v1/auth/session`) take an optional `organizationId`. A
  token with `organizations` admits a member only in an organization that it lists
  and that the request names. An owner token needs none. A token of the old mint
  keeps its one organization and ignores the name. The clients send the name from
  stage 1c.
- **`authRenew`.** The host accepts the next token only for the same person, with
  the same standing: the owner stays the owner, and a member keeps the same role and
  teams in the socket's organization. Other changes end the socket at its old
  expiry, and the client connects again. The client transport sends the next token
  60 s before the current one ends, from the same grant source that it dials with.
  A connection with no expiry (Electron IPC, pairing) has nothing to renew.

Stage 1c-i (2026-10-09) moved desktop, web, and the CLI to `OAuthSession`. It made
these decisions where the text above was not exact:

- **The browser step starts before the address exists.** The loopback port is known
  only when the server listens, so `BrowserAuthorizer.start()` gives a
  `BrowserAuthorization` with `redirectUri`, `complete(authorizeUrl)`, and `cancel()`,
  in place of `authorize()` and `redirectUri()`. The desktop's
  (`account/loopback-authorizer.ts`) listens on 127.0.0.1 and port 0, accepts one
  `GET /callback` with the sign-in's `state`, answers a small page, and closes. It
  ends after 10 minutes, or when it is cancelled.
- **`OAuthSession` has more than §3.2 lists.** `cancelSignIn()`; `reload()` (the
  desktop keychain can be read only after `ready`); `beginSignIn()` and
  `completeSignIn()`, which the web client calls itself across its redirect;
  `adoptTokens()` for the CLI's device grant; and `accessToken(resource, { fresh })`
  after a host refuses a kept token. All refreshes run one at a time, for every
  resource, and each one saves the rotated refresh token before it gives out the
  access token. Sign-out waits for a running refresh, then revokes the newest token.
- **Discovery.** The provider serves its metadata only to the server. The cloud
  serves it at the issuer, `<appOrigin>/.well-known/openid-configuration`
  (`routes/.well-known/openid-configuration`), and the client checks that `issuer`
  is the origin it asked.
- **The ID token signature.** The client gets the ID token straight from the token
  endpoint over TLS, so it does not check the signature (OIDC Core §3.1.3.7, rule 6).
  It checks `iss`, `aud`, `exp`, and `nonce`. This keeps client-core free of a JWT
  library, which mobile cannot load as is.
- **Web storage.** The refresh token is kept in page memory. When the page goes
  (`pagehide`) it is written to `sessionStorage`, and the next page of the tab takes
  it and deletes it. A reload keeps the sign-in; a closed tab ends it; a duplicated
  tab, which copies `sessionStorage` while the page lives, finds nothing and signs in
  by itself, so two tabs never refresh one grant (replay, above). A page with no
  sign-in makes one silent sign-in per minute (`prompt=none`) with the website's
  cookie. The callback `/auth/callback` is a cloud route that serves the client with
  no gate. With no cookie, a member goes to the sign-in page and a guest of a share
  link stays a guest. Sign-out on the web ends the grant and then the cookie, because
  on the account origin the page and the website are one, and the cookie would sign
  the page in again.
- **The CLI keeps no sign-in.** `solus connect` signs in with the device grant, uses
  account-plane tokens for its two calls, and revokes the grant at the end.
- **The account API with a token has no active organization.** A token caller has no
  Better Auth session, so `/v1/hosts` and `/v1/account` read
  `activeOrganizationId` as null. The client chooses the organization itself
  (`organizationIdFor`).
- **What still uses the old paths, for the next stages:** mobile (device grant with a
  session token, `/api/account/me`, `/api/account/device-label`, the mint, and
  `HostGrantCache`, now used only by mobile; its legacy sign-in is in
  `apps/mobile/src/features/account/session-token-sign-in.ts`); `ownerAccessToken`
  (now from `accessToken({ kind: 'host', hostId })`); and the cloud's mint route,
  `/device/token` for `solus-desktop` and `solus-mobile`, `/api/account/me`, and
  `/api/account/device-label`, which only mobile calls.

Stage 1c-ii (2026-10-09) moved mobile to `OAuthSession` and deleted the old paths. It
made these decisions where the text above was not exact:

- **Mobile.** The client is `solus-mobile` with the redirect `solus://auth/callback`
  (the app scheme is `solus`). The browser step is the system authentication session
  (`expo-web-browser` `openAuthSessionAsync`, `features/account/auth-session-authorizer.ts`);
  only a redirect to that address is a callback. Hermes has no Web Crypto, so the app
  gives `OAuthSession` its random bytes and SHA-256 from `expo-crypto` (a new
  dependency; a native build is necessary). The `TokenStore` is the keychain
  (`keychain-token-store.ts`): the keychain answers later, so the store keeps the grant
  in memory and writes it through in order. A rotated refresh token is in memory before
  the access token is used, and in the keychain a moment later; an app that is killed
  in that moment signs in again. A cold start reads `/userinfo` again
  (`refreshIdentity`). The directory reads `/v1/account` and `/v1/hosts` apart: hosts
  apply when the account read fails, and the organizations shown before stay. A dial
  names its organization with `organizationIdFor`, as on desktop and web.
- **Claims.** `accessTokenClaimsSchema` is now two schemas. A person's token
  (`personAccessTokenClaimsSchema`) requires `grant_id` and lists `organizations`; it has
  no `deviceId` and no single organization. A delegated token
  (`delegatedAccessTokenClaimsSchema`) keeps its shape until stage 4: `act`, one
  `organizationId` with `organizationRole` and `teamIds`, and `deviceId` (the acting
  host). A host refuses a token that states a life longer than
  `ACCESS_TOKEN_TTL_SECONDS` and one minute.
- **Guests.** The `guest` access kind and `guest:` subjects are gone from tokens. A guest
  is admitted by a share secret alone, as before.
- **Resources.** Each host resource and the Solus API and account resources set
  `accessTokenTtl` 300 (`resourceSeedMode: 'merge'` brings it to rows seeded before).
  `enforcePerClientResources` is on. The four Solus clients are linked to the Solus API,
  the account plane, and every host resource; a host client is linked to its delegated
  resources (`auth/client-resources.ts`). Linking runs at every start and at each
  registration.
- **Refresh life.** The provider sets the refresh-token life per resource, not per
  client, and the Solus clients share the Solus API and account resources with the
  delegated tokens. So the 100-year sliding life stays for both until stage 4.
- **Device grant.** Only `solus-cli` may start one. The plugin's `/device/token`, which
  answers a session token, is disabled; the CLI redeems its code at the token endpoint.
  The `bearer()` plugin is removed: no client sends a session token.
- **Audit kinds.** `host_grant_issued`, `workspace_grant_issued`, and
  `guest_grant_issued` are removed from `AuditKind`. The column is text, so no migration
  is necessary; old rows show nothing, as before.
- **Executor routes.** Until stage 5 they keep the host token and the body token. A
  person's token is alive while its client grant is (the grant must be the person's);
  a member reaches through the organizations the token lists.

Stage 4 (2026-10-09) bound delegations to client grants and added the personal scope.
It made these decisions where the text above was not exact:

- **Where the grant is kept.** A delegation's refresh token keeps
  `referenceId = {"grantId", "scope"}` as JSON (`auth/token-exchange.ts`,
  `DelegationReference`). The provider carries the reference through every rotation and
  gives it to the claims hook, so each refresh checks again that the grant is alive
  (`isGrantAlive`) and that the person stands in the scope (`delegationAlive`). No table
  was added: a second table would have to follow the provider's rows, and a deleted or
  revoked refresh token takes its reference with it. A reference of the old form (an
  organization id) has no grant, and its next refresh is refused.
- **The exchange.** The subject token must be a person's token for this host, with
  `grant_id` and no `act`. The scope is `organization_id`, or `delegation_scope=personal`
  and no organization. `personal` is for the owner of a personal host only (`hostReach`);
  anyone else gets `not_the_owner`. A refused issue or refresh is `invalid_grant` with
  `solus_refusal`; a revoked grant is `grant_revoked`, and the host reads it as
  `GRANT_REVOKED`.
- **Claims.** A delegated token has `act`, a required `grant_id`, and either
  `access: 'owner'` with no organization (personal) or `access: 'org-member'` with one
  `organizationId`, `organizationRole`, and `teamIds`. `deviceId` is gone: the acting
  host is `act.host_id`. The Solus API admits nothing with a personal delegation.
  `delegatedUser` on the executor routes checks the grant and the scope in the same way.
- **Refresh life.** The 100-year sliding life stays. The provider sets it per resource,
  and the Solus clients share the Solus API and account resources with delegations. The
  grant check at each refresh is the limit: a sign-out ends a delegation at its next
  refresh, within one access-token life (5 minutes).
- **Where a delegation is made.** The host's ticket door (`/auth/ws-ticket`) and the
  combined host's Solus API admission call `Delegations.establish` for each admitted
  person's token, without waiting: `personal` for an owner, and the organization the
  connection names (for a member, only one that the token lists). A turn that comes
  while the exchange runs waits for it. A delegation that is held is not made again: it
  stays bound to the grant that made it. When that grant ends, the person's work in that
  scope ends, and their next connection makes a new one. The desktop owner works over
  IPC and presents no token, so until stage 6 the desktop's own sign-in
  (`ownerAccessToken`) makes the owner's personal and organization delegations when the
  host's standing changes. The Solus API in API mode makes no delegations.
- **The host.** `Delegations` is keyed by person and scope, gets a token for one
  resource at a time (`resource` at each refresh; refreshes run one at a time), and keeps
  `{ version: 2, delegations: [{ userId, scope, refreshToken }] }` in the secret store. A
  file of another version is discarded. The refusal codes keep their names
  (`ORGANIZATION_ACCESS_REFUSED`, `ORGANIZATION_API_UNAVAILABLE`,
  `ORGANIZATION_AUTHORITY_MISSING`) and add `GRANT_REVOKED`; a turn shows
  `GRANT_REVOKED` as `ORGANIZATION_AUTHORITY_MISSING` (sign in again). A refusal of an
  organization delegation stops the person's sessions there, drops their queued rows,
  and pauses their automations. The host is told before the delegation is forgotten,
  so it still knows which sessions to stop (before, it was told after, and stopped
  none). A personal delegation carries only account reads, so its refusal stops nothing
  else. Account reads use the person's delegation first (personal, then an
  organization's), then a token they presented (`personAccessToken`, until stage 5).
- **The Devices page.** It lists browser sessions as before, then the person's
  signed-in apps (one row per live client grant: the app, first sign-in, last refresh)
  and the hosts that act for them (host, scope, start, last refresh, from a live grant
  only). Signing an app out there deletes the refresh tokens of its grant, and the
  delegations made from it are refused at their next refresh. Stopping a host deletes
  that delegation's refresh tokens only (`auth/grants.ts`). Both delete and do not mark
  revoked: the provider reads the use of a revoked refresh token as a replay and ends
  every grant of that client and person (limit 1 below), so one revocation would end
  more than it names.
- **Unlink.** It deletes the host's client and, through the foreign keys, its
  delegations. No grant changes.

Stage 5 (2026-10-09) gave hosts and the Solus API their keys and moved every account
read to delegated bearer tokens. It made these decisions where the text above was not
exact:

- **The key.** ES256 on P-256 (`host/host-credential.ts`). The provider accepts ES256 for
  `private_key_jwt`, and the access tokens already use it. The host makes the pair with
  Web Crypto; the private JWK is kept in the secret store (`host-credential`) with the
  client id and the link generation it is for. An assertion lives 60 s and has a new
  `jti` each time. `HostCredential` has a fourth member, `tokenEndpoint`, so the Solus
  API, which has no link, uses the same object.
- **The control audience.** A host's own token is a client credentials token for a new
  resource, `CONTROL_AUDIENCE = urn:solus:control`, scope `host:link`, life 300 s. It is
  not `ACCOUNT_AUDIENCE`: that audience is for a person's data, and a host token must
  never read it. The claims hook adds `host_id` and `host_generation` (from the client's
  metadata). `requireHostClient(event, hostId)` (`uplink/v1.ts`) verifies the token; the
  operation then requires that the host's client still exists and that
  `host_generation` is the link's current generation. So a superseded copy is refused at
  once, not after its last token ends. The error is `invalid_host_credential`.
- **Enrollment.** `EnrollHostRequest` has `publicJwk`; the answer has
  `oauthClient: { clientId }` and no `hostToken`. Each link makes a new key, so linking
  again rotates it: the client is registered again, and the old key gets nothing.
- **Managed hosts.** The host makes its key at first boot. The provisioner puts
  `{ link, credentialTicket }` (`HostLinkEnv`) in `SOLUS_HOST_LINK`; the ticket (`hct_`)
  is kept as SHA-256 in `host_link.credential_ticket_hash` and works once
  (`POST /v1/hosts/:hostId/credential`). The same key sent again is accepted, so a boot
  whose answer was lost retries with the key it kept. This was chosen over a key that
  the provisioner makes: then the private key would pass through the provider and sit
  in the boot files, a long-lived secret outside the machine. A deleted managed host's
  client is removed with its link (before, it stayed).
- **The Solus API.** It is the confidential client `solus-api`, with `private_key_jwt` and
  the public half of `SOLUS_API_CLIENT_KEY` (a private ES256 JWK), written at every start
  of the account site. In API mode the server reads the same variable, takes it out of
  its environment, and builds `Delegations` with it. Its admission makes a delegation
  for the organization the request names, with the API token presented, never a
  personal one (`establishWith`). The exchange accepts a subject whose audience is
  `SOLUS_API_AUDIENCE` only from `solus-api`, and a host audience only from that host.
  Its delegated token is for `ACCOUNT_AUDIENCE` only, and its `act` has no `host_id`
  (`tokenActorSchema.host_id` is optional); a host's door and the API's runner door
  refuse a delegated token with no host. Its standing is the person's membership in the
  organization. The Devices page does not list the Solus API's delegations.
- **Executor routes.** `delegatedUser(db, issuer, authorization)` has one branch: a
  delegated token for `ACCOUNT_AUDIENCE` whose actor is a host or `solus-api`, whose
  grant is alive, and whose person stands in its scope (`delegationAlive`). The read
  routes take no body; the profile credential routes take `{ serverUrl, … }` and no
  `accessToken`. A cookie is refused.
- **`AccountReads`.** `fetch(userId, scope, path, init)` answers a `Response`, or an
  `AccountReadRefusal` (`NOT_LINKED`, `NO_DELEGATION`, `UNREACHABLE`, with a message)
  in place of `null`, so each caller can say why. A `null` scope uses any delegation the
  person has here, the personal one first: an account read is the person's own data,
  and each call checks the delegation alive. `vault/account-integrations.ts` is deleted;
  the desktop owner's delegations are still made from `ownerAccessToken` in
  `boot-server.ts` until stage 6. A person's token that a client presented is no longer
  kept (`rememberPersonToken`): with no delegation there is no read.
- **Migration.** `0007` adds `credential_ticket_hash`, drops `host_token_hash`, and
  deletes every host client that does not use `private_key_jwt`, with its delegations
  (a secret must not keep acting). Each host links again (§4).

Stage 6 (2026-10-09) made the desktop owner an ordinary client. It made these
decisions where the text above was not exact:

- **Main is the client.** The desktop's main process holds the sign-in, so main is the
  client of its own host, not the window. The booted server has one narrow door for it,
  `LocalClient` (`transport/local-client.ts`): `presentToken(token)`, `signedOut()`,
  `lendHostAccess(access)`, `hostId()`, and `onTokenWanted(listener)`. Main
  (`account/local-host-client.ts`) presents its token for this host when it signs in,
  at start when it is signed in, and when the host asks again. The host asks only when
  its standing changes (a link made, an organization added) and the owner has no
  delegation for a scope; it asks for nothing else, and keeps no token. The host
  verifies the token as the ticket door does and calls the same `establish`:
  `personal` for the owner, and each organization the host stands in that the token
  admits (`delegationScopesFor`, now in `sync/delegations.ts`). Main has no one
  organization per connection, as a socket has, so it presents for all of them. The
  `ownerAccessToken` and `ownerHosts` boot options and `establishOwnerDelegations` are
  deleted. Every account read for the owner goes through `AccountReads` with the
  delegation that the presented token made.
- **Sign-out is known at once.** A delegation keeps the grant it was made from
  (`grantId`; the secret file is version 3, and a file of version 2 is discarded:
  its people connect again). When main's sign-in ends (sign-out, or a grant the
  website ended), main calls `signedOut()`, and the host calls
  `Delegations.forgetGrant` for each grant that main presented. The effect is the
  same as the account plane's refusal at the next refresh (`onRevoked` with
  `GRANT_REVOKED`), but now. Delegations made from another client's grant stay.
- **The window keeps a local-owner credential.** Rule 10's text is changed here. The
  window connects to its own host with a host session token (`local-owner`, "This
  Mac"), signed in or not. The window and the host are one app on one machine: the
  window must open its host offline, before the host is linked, and while the account
  plane does not answer, and some actions are for this machine only (the GitHub
  credential export). An account token would give the window `remote-owner` standing
  and make each reconnect depend on the cloud. The credential carries no account: the
  owner's account access comes only from main's presented token. It is kept encrypted
  with the keychain (`local-session-token.bin`, `local-owner-token.ts`) so the window
  keeps one device id; with no keychain it is kept in memory only. The plaintext
  `local-session-token.json` of earlier versions is removed unread at start, so each
  install gets a new local device id once. Nothing else used that file.
- **Cross-host sessions use the client's reach (option b).** A host that starts work on
  the owner's other hosts (docs/plans/cross-host-sessions.md) dials them with a token
  that the signed-in client got for that host, lent through `lendHostAccess`; the
  directory is the client's `GET /v1/hosts`. `RemoteHosts` reads the loan at each use,
  and a sign-out takes it back, so the reach ends with the grant (rule 5). The token
  is used only at its own audience and is not kept, so rule 3 holds. The other
  option, a delegated token for another host's audience, was refused: a delegated
  token is for the Solus API or the account plane, never for a host; it needed a
  token-exchange change in the cloud and a new admission at every host's door; and it
  gave an unattended host reach to all of the owner's hosts for the life of a grant.
  So a standalone or managed host has no account reach to other hosts; pairing stays.
  No cloud change was needed.

Two limits to accept or work around:

1. **Replay detection ends the whole family.** When a revoked refresh token is used
   again, the provider deletes every refresh token of that **client id and user**.
   All desktop installs share `solus-desktop`, so a replay on one Mac signs out the
   other Mac too. The fix, if needed: each install registers its own public client
   (dynamic registration, `/oauth2/register`).
   **Accepted (2026-10-09).** A replay only means "sign in again". Each client has
   one refresher, which saves the new refresh token before it uses it, so Solus
   causes no replay of its own.
2. **`sid` is the Better Auth session.** The provider emits the session that
   approved the sign-in as `sid`. Our grant claim is `grant_id`.

## 6. Decided questions

1. **The web client off the account origin** uses local access only, as today.
2. **The Solus API's service key** goes. The API uses token exchange, as hosts do
   (§3.5), so every caller of the account plane takes one path. An in-process
   function was simpler at run time, but it was a second mechanism, and it would
   break if the API ran apart from the account site.
3. **Replay detection** is accepted (§5).
4. **The organization in a token.** The custom mint put one organization, which
   the client chose, in each token. The standard refresh grant has no field for
   that. So an access token lists the person's memberships that apply to its
   audience: `organizations: [{ id, role, teamIds }]`. For a host, these are the
   organizations the host is shared with or managed for. For the Solus API, they
   are all of the person's organizations. The owner of a personal host gets
   `access: 'owner'`. A connection names one organization (the WebSocket ticket
   request, or the API request), and the server admits it only when the token
   lists it. The cloud refuses a host token to a person who cannot reach that
   host, at issue time, in the claims hook.

## 7. Stages

Each stage ships with focused tests in both repositories.

1. **Sign-in and identity, server side (1a, done).** The four public clients,
   PKCE, ID token, `/userinfo`, `grant_id`, host resources, the CLI device grant.
2. **Servers accept the new tokens (1b, done).** The cloud adds Solus claims and the reach
   check to refresh-grant tokens (§6.4), and its account routes accept a `Bearer`
   access token for `ACCOUNT_AUDIENCE`. Hosts and the Solus API accept tokens with
   `grant_id` and `organizations`. `authRenew` on the socket, in the host and in
   the client transport. §5 records the details.
3. **Clients switch (1c, done).** Desktop, web, and the CLI in 1c-i; mobile and the
   deletions in 1c-ii (§5). `OAuthSession`, `BrowserAuthorizer`, and `TokenStore` on
   desktop, mobile, and web; `AccountState` with `identity`; the CLI on OAuth
   tokens. Delete the mint, `HostGrantCache`, `/api/account/me`, the
   session-token grant, and `deviceId`. Set 300 s per resource and
   `enforcePerClientResources`.
4. **Grants and sign-out (done).** `grant_id`, revocation, grant-bound delegations,
   `personal` scope, the Devices page (§5).
5. **Hosts and the Solus API (done).** `HostCredential` with `private_key_jwt`; executor
   routes on bearer delegated tokens; `AccountReads`; delete the token side paths (§5).
6. **Desktop owner (done).** The desktop's main process presents its token to its own
   host as a client; cross-host reach is lent by that client; the window's
   local-owner credential is kept encrypted; what remained of §2.3 is deleted (§5).

## Appendix A — What the change deletes (inventory, 2026-10-09)

About 800 lines in solus-cloud and 950 in solus, not counting replacement code.

Stage 1c-ii deleted the mint, `/api/account/me`, `/api/account/device-label`,
`GRANT_TTL`, the `solus-desktop` and `solus-mobile` device clients, the guest audit kind,
`HostGrantCache`, `deviceId` and the 8-hour and guest lifetimes, the request and response
schemas of the mint, and the `guest` access kind. Stage 5 deleted the host token and
the client secret (`sht_`, `shc_`, `hostTokenFromAuthorization`, `requireHostToken`,
`linkByHostToken`, `InvalidHostToken`, `host_link.host_token_hash`, the hashed host
client secret), `isServiceKey`, `linkedExecutor`, the API-audience and body-token
branches of `delegatedUser`, `INTEGRATION_SERVICE_KEY` and
`SOLUS_INTEGRATION_SERVICE_KEY`, `vault/account-integrations.ts` (with
`personAccessToken`, `ownPersonToken`, `rememberPersonToken`, `useOwnerToken`,
`useDelegatedTokens`, `useIntegrationExecutor`), `hostToken` and `clientSecret` in
enrollment, and the `hostToken()` and `oauthClient()` getters of the link manager.
Stage 6 deleted the `ownerAccessToken` and `ownerHosts` boot options,
`establishOwnerDelegations`, `remoteHostsFor`, the plaintext `local-session-token.json`
(read and write), the stale `acquireHostAccessToken` in test fixtures, and the guest
grant words in the OpenAPI text, the Lab, and tests. The e2e and proof scripts moved to
the host key, delegated tokens, and `/oauth2/userinfo` (they typecheck; they need live
services and were not run). Nothing in the list below
remains in code.

**solus-cloud**
- The mint: `routes/v1/hosts/[hostId]/access-token`; `auth/oauth.ts` first-party
  client, claims, and `firstPartyTokens`; `uplink/hosts.ts` `issueHostAccessToken`
  and `issueWorkspaceAccessToken`; `uplink/grants.ts`.
- `routes/api/account/me`; `GRANT_TTL`; the `solus-desktop` and `solus-mobile`
  device clients (`solus-cli` stays); `routes/api/account/device-label`.
- `integrations/authorization.ts`: `isServiceKey`, `linkedExecutor`, the API
  audience branch, and the body-token branch; `INTEGRATION_SERVICE_KEY`.
- Host token and client secret: `sht_`/`shc_` in `uplink/tokens.ts`,
  `requireHostToken` in `uplink/v1.ts`, `linkByHostToken`, `host_link.host_token_hash`.
- `'guest_grant_issued'`; the matching schemas in `src/lib/shared/uplink.ts`.

**solus**
- `client-core/host-grant-cache.ts`; `cloud-account.ts` `readProfile` and
  `profileFromResponse`; `uplink-session.ts` `acquireHostAccessToken`.
- `server/vault/account-integrations.ts` (whole module).
- `boot-server.ts` `ownerAccessToken`, `ownerHosts`, `useOwnerToken`,
  `useDelegatedTokens`; the owner path in `remote-hosts.ts`;
  `rememberPersonToken` in `http.ts` and `solus-api/admission.ts`;
  `Delegations`' `personToken`.
- `contracts/uplink.ts`: the 8-hour and guest lifetimes,
  `hostAccessTokenRequest`/`ResponseSchema`, `hostToken` and `clientSecret` in
  enrollment, the `guest` access kind, `deviceId`.
- Desktop: the device flow, grant cache, and `acquireHostAccessToken` in
  `account-session.ts` and `uplink-client.ts`. Mobile: the same in
  `features/account`.
- `transport/uplink/link.ts` host token and client secret storage.

**Stays, as local access (rule 10):** pairing, host session tokens, `/auth/refresh`,
`revoked-devices.json` for paired devices, share-secret tickets, and the CLI's
device flow (with OAuth tokens). **Stays, on purpose:** the desktop window's
local-owner host session token, encrypted (stage 6, §5); the `shareSecret` field of
the Solus API credential request, which admits nothing there (a contract change is not
this ADR's); tests that send an old `sht_` bearer to prove that it is refused; and
`clientSecret` of third-party OAuth clients (MCP servers, GitHub, Google sign-in),
which is not a Solus credential.
