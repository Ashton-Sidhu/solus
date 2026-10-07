# Project model

Many comments in the code refer to this document by section. It records the rule
that every client uses to list projects.

## §1 Identity

- A **project** is a Git repository. Its key is the repository key: the lowercase
  `host/path` of its primary remote, for example `github.com/acme/web`
  (`packages/contracts/src/repository-key.ts`).
- A **checkout** is one folder that holds a project on one host. A project can
  have many checkouts on many hosts.
- A folder with no hosted remote is a **local-only project**. Its key is
  `localProjectKey(serverId, path)`, so the same path on two hosts is two
  projects.
- A path alone does not identify a project. Always resolve a folder through
  its host (`projectsStore.projectKeyFor(serverId, path)`).

## §4 Tasks

A cloud task names its repository key. A host task names a path, and the
checkout on its host resolves that path to a project key
(`tasksStore.projectKeyOf`). Thus one project lists the tasks of all its
checkouts.

## §5 Project lists

A list that lets the user pick or filter by project shows **one row for each
project, never one row for each checkout or host**. Every client uses the same
rule:

- `packages/client-core/src/project-identity.ts` groups checkouts into projects
  (`groupByProject`, `projectKeyOf`) and makes the labels
  (`distinctProjectLabels`). When two rows in one list have the same name, the
  label of a repository becomes `owner/name` (or the full key if `owner/name` is
  also the same). The label of a local-only folder becomes `name · host`.
- On desktop and web, `projectOptionsFor(projectKeys)` on the surface context
  (`contexts/projects/project-catalog.ts`) builds the rows for a list. These
  lists use it: the Tasks and Pull request pages, the ⌘P picker scope, the
  sidebar project filter, the breadcrumb project menu, the Works page filter,
  and the Automations page.
- The composer project chip keeps one checkout per row, because it chooses
  where to run, but it uses the same labels.
- Mobile groups its new-task picker and Home filter with `groupProjectScopes`
  (`apps/mobile/src/features/threads/new-task-project-selection.ts`), which
  uses the same module.

A page that is scoped to a project keeps the project key and, when it needs
to read from a host, one representative checkout (`ProjectPageScope`). A
search that is scoped to a project asks each host for its own checkout of the
project, and does not ask a host that has no checkout.

Lists that choose a **folder on one host** are not project lists, and they
stay per host: the directory picker and its recent folders, Settings →
Projects, the palette's "Create task in…", and device builds.
