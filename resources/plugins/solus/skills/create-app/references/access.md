# Secrets, integrations, and permissions

## Secrets

```ts
secrets: { database: { label: 'Database URL', description: 'A Postgres URL that this app may read.' } },
```

Declare a value the app needs from the user and must not show: a database URL, an API key. The user sets it on the app's Manage page, and the receipt of a deploy says which are not set. Never ask for a secret in the UI, and never keep one in `storage`, in the database, or in a log line. When an operation needs a secret that is not set, throw an error that names it and says to set it on the Manage page, and show that message in the UI.

## Integrations

```ts
integrations: ['linear', 'github'],
```

Name each integration the app calls, by the slug `connection_status` shows. The backend calls `ctx.tools.<slug>.<tool>(input)`, and the UI can call `tools.<slug>.<tool>(input)` from `@solus/app`. Each call runs with the caller's own connection; a schedule, a webhook, and a workflow run with the owner's. A call answers the tool's structured content, or its text parsed as JSON. A call to an integration the user has not connected fails with a message that says to connect it; show that message.

`github`, `atlassian`, and `google` are also the built-in connections of Solus (Settings → Integrations). When the user has no MCP integration with that slug, the role is the built-in connection. It has one tool, `request`, that sends one REST call with the user's own sign-in. The host adds the credential, so the app needs no secret and no network permission for it. `path` starts with one `/`, `method` is `GET` when you leave it out, and the answer is the response body.

```ts
await ctx.tools.github.request({ method: 'GET', path: '/repos/acme/web/pulls', query: { state: 'open' } })   // api.github.com
await ctx.tools.atlassian.request({ product: 'confluence', path: '/wiki/api/v2/pages/123' })                 // Confluence; product 'jira' for Jira
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
