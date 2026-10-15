# Agent session links

The existing `link` tool can attach a work, automation, pull request, or file to
the calling session when `task_id` is omitted. Project plans are files:

```ts
link({ kind: 'work', target_id: '<work-id>' })
link({ kind: 'automation', target_id: '<automation-id>' })
link({ kind: 'pr', target_id: '<number-or-GitHub-URL>' })
link({ kind: 'file', path: 'docs/plans/example.md' })
```

Works use their existing session membership. PRs retain their existing link,
watch, and settlement behavior. Automations and files use `session_links`, with
the owning host, target, label, actor, and link time. Repeated calls retain one
reference. A file link references the current host file; it does not copy its body.

The tool checks session edit access and target access. File paths are resolved
on the execution host, relative to the caller's working directory, with home
paths and symlinks resolved. A file must exist when it is linked. An automation
link does not enable or run the automation.

Organization links use the existing sessions outbox with verb `link-item`.
The tool reports that the link is queued. Delivery checks the session's
organization and reuses the same idempotent write. Work links require the work
to belong to that organization. File and automation references retain their
execution host; the organization service does not read a runner's filesystem.

Existing task links, including indexed Solus plans and task/session roles,
retain their meaning. Files use session links. This change adds no client UI,
HTTP endpoints, or additional agent tools.

Verification: `tests/unit/session-links.test.ts` covers file path resolution,
repeat calls, existing work membership, automation references, rejected writes,
organization boundaries, and session outbox delivery. Existing session PR and
agent toolbox tests cover the unchanged PR path and both provider tool surfaces.
