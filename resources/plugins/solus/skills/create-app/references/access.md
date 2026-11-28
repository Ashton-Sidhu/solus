# Secrets, integrations, and permissions

## Check service access

1. Search the available tools for the service and the operations the app needs. Check their inputs and limits. See [Integrations](#integrations) for built-in Solus connections.
2. When the task authorizes a read, make a small read-only call against the relevant data to confirm access. If the connection state is unclear or sign-in is needed, use `connection_status` with the integration slug. It can ask the user to connect. If access still needs setup, continue with the parts you can build and say which live behavior you could not verify.
3. Use the existing connection if it supports the required operations and callers. If no integration meets the app's needs, use a direct API. Declare an app secret only if that API requires a credential.

An account can be signed in and still lack access to a particular repository, database, or workspace. If the read fails, explain whether the caller must connect an account, select a different source, or grant access to that source. Retry a temporary service failure without asking the user to sign in again.

## Secrets

```ts
secrets: { database: { label: 'Database URL', description: 'A Postgres URL that this app may read.' } },
```

Declare a value the app needs from the user and must not show: a database URL, an API key. The user sets it on the app's Manage page, and the receipt of a deploy says which are not set. Never ask for a secret in the UI, and never keep one in `storage`, in the database, or in a log line. When an operation needs a secret that is not set, throw an error that names it and says to set it on the Manage page, and show that message in the UI.

## Integrations

```ts
integrations: ['linear', 'github'],
```

Name each integration the app calls, by the slug `connection_status` shows. The backend calls `ctx.tools.<slug>.<tool>(input)`, and the UI can call `tools.<slug>.<tool>(input)` from `@solus/app`. An integration has one of two scopes, and a name is in one of them only:

- `integrations`: a **user connection**. Each call runs with the caller's own connection. A call with no person cannot use it: a schedule, a webhook, a workflow, and a visitor of a published app.
- `appIntegrations`: an **app connection**. Each call runs with the owner's connection, whoever calls, and the app's background work uses it too. Use it for what the app itself needs, such as a team's tracker. In a published app, each visitor acts with it through your code, so expose only what a visitor may do.

Choose the scope from the real entry point. An interactive review can use the person's own account. A scheduled digest or webhook handler that reads the same service needs the app's connection. Check the account's access from that entry point after deploy.

```ts
integrations: ['linear'],        // the caller's own Linear
appIntegrations: ['github'],     // the owner's GitHub, for each caller and each schedule
```

A call answers the tool's structured content, or its text parsed as JSON. A call to an integration the user has not connected fails with a message that says to connect it; show that message.

`github`, `atlassian`, and `google` are also the built-in connections of Solus (Settings → Integrations). When the user has no MCP integration with that slug, the role is the built-in connection. It has one tool, `request`, that sends one REST call with the user's own sign-in. The host adds the credential, so the app needs no secret and no network permission for it. `path` starts with one `/`, `method` is `GET` when you leave it out, and the answer is the response body. A `query` value can be a string, a number, a boolean, or a list (sent as one comma-separated value). Atlassian's `product` is `confluence` for a path under `/wiki/` and `jira` for any other path when you leave it out.

```ts
await ctx.tools.github.request({ method: 'GET', path: '/repos/acme/web/pulls', query: { state: 'open' } })   // api.github.com
await ctx.tools.atlassian.request({ path: '/wiki/api/v2/pages/123' })                                       // Confluence
await ctx.tools.atlassian.request({ path: '/rest/api/3/search/jql', query: { jql: 'project = ENG', maxResults: 50 } })   // Jira
await ctx.tools.google.request({ path: '/drive/v3/files', query: { q: "name contains 'Q3'" } })              // www.googleapis.com
```

## Permissions

```ts
permissions: {
  network: ['api.example.com', 'db.internal:5432'],
  files: { read: ['~/Documents/data'], write: [] },
},
```

- `network`: hosts the backend and the UI reach. A host, a host with a port, `*.example.com`, or `'*'` for every host.
- `files`: absolute or `~/` host paths the backend reads and writes. `'*'` is every path. A path it may write, it may read.

The app's own database, its app files, and `ctx.files.dir` need no permission. Solus refuses a host or a path the app did not declare, and the app's Manage page shows what each version declares. Ask for exactly what the app uses: a database browser that takes any URL needs `network: ['*']`; one for a single known database needs that one host. Open a SQLite file of the user's that you only read with `{ readOnly: true }`.
