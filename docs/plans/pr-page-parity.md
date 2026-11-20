# PR page parity

Implement named personal PR views, PR and comment reactions, consistent state
and sort controls, queue sorts, multiple label filters, and read-only PR URL
inspection. Desktop and web share the workspace UI; native mobile has its own
controls. Personal settings own saved views. GitHub owns reactions and PR facts.
Reading a URL must not add a project, clone a repository, or prepare a checkout.

Filters use Authored by me and Assigned to me; Review requested remains a PR
role. Blocked on me means an open PR waiting on the acting person's review, or
an authored PR with failed checks, requested changes or a merge conflict. Size
sorts order loaded results only. Unsupported code hosts must give a clear error.

Use focused fixture tests, contract and native checks. Do not build the app,
start a server, deploy, apply live migrations or change live data.

## Checklist

- [x] Named saved views with account sync on every client
- [x] PR and comment reactions with target validation and Retry
- [x] Open, Merged, Closed, All and the same sort choices
- [x] Blocked on me, smallest, largest, oldest sorts
- [x] Multiple include and exclude labels
- [x] Read-only URL inspection without a project
- [x] Shared filter labels and clear/refresh/retry states
- [x] Focused tests and documentation

## Verification

- 144 focused tests pass across PR views, filters, queue sorts, reaction state,
  GitHub target ownership, URL inspection, native metadata reads, private media,
  task role searches and RPC planes.
- Shared contract typecheck and generated API validation pass. All six changed
  PR Svelte components compile. Focused lint passes for the new owners and filter
  helpers. GitHub reaction queries validate against the official schema.
- Full server and workspace checks still report errors outside this change.
  Examples are the agent SDK adapters, `ActivityFeed` input binding, and missing
  `PrListLoading` declarations. The latest native check reports unrelated thread
  list errors for `ThreadPrPresentation.unlinkTargets`; an earlier native check
  passed before that file changed.
- Interactive desktop, web and native flows were not run. No dev server or build
  was started, and no live data, credentials or database schema was changed.

## Review notes

New logic lives in focused files. `PrsPage.svelte`, `ActivityFeed.svelte` and
`provider-handlers.ts` were already over 1,000 lines. This change adds small
integration points there; the existing file sizes remain a review concern.

Entry points: PR list and PR detail on all three clients. Shared RPC methods
carry reactions and URL reads over IPC and WebSockets. Saved views use personal
settings sync; GitHub owns reactions. Provider runtimes are not involved. Views
can be removed, reactions can be removed, and inspection can be closed. Reads
have stale guards, errors and Retry; metadata owners are per mounted list. Code
host support is public GitHub URLs, including private repositories that the
person's connection can read.
