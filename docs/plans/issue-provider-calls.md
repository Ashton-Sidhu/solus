# One provider call for each issue operation

Status: done. Two parts are left out; steps 4 and 7 name them.

## Problem

Solus calls GitHub, Jira and Linear more often than an issue operation needs.
T3 Code (`apps/mobile/packages/source-control-github`) reads an issue page with
one GraphQL query: body, comments, timeline and closing pull requests. Solus
needs two RPCs and two to five provider calls for the same page, and reads the
issue again after most writes.

| Operation | Solus today | Target |
|---|---|---|
| Issue page, GitHub | 2 RPCs; GraphQL detail, then a REST timeline that reads the comments again; up to 3 retries of the whole query when preview fields or `read:project` are refused | 1 RPC, 1 GraphQL query (+1 parallel status read) |
| Issue page, Jira | 2 RPCs; issue, epic, then issue and epic again, then changelog (5 calls) | 1 RPC, 1 call (`expand=changelog,transitions`), epic only when shown |
| Issue page, Linear | 2 RPCs; `readIssue`, then `inspectLinearIssue` | 1 RPC, 1 query |
| Update, GitHub | REST PATCH, then a GraphQL re-read; Project fields add a pre-read, a fields query and one mutation for each field | 1 PATCH (task built from its answer); Project fields in one aliased mutation |
| Update, Jira | PUT, then re-read issue and epic | 1 PUT (`returnIssue=true`, to be confirmed) |
| Update, Linear | `choices()`, full pre-read, mutation | 1 mutation (organization and choices cached) |
| Move, GitHub | pre-read, then a mutation for each Project, one after the other | 1 aliased mutation |
| Move, Jira | GET transitions, POST, re-read | 1 POST (transitions from the detail read) |
| Move, Linear | `choices()`, pre-read, mutation | 1 mutation |
| Comment, Linear | pre-read, mutation | 1 mutation |

## Decisions

Reads follow T3 Code: one list RPC, and one detail RPC for each issue. Writes do
not: a Solus write already answers the new state, so it needs no second RPC.
The `issues.invalidated` event stays; an open issue re-reads the host's copy.

1. **The issue list is one RPC.** `issuesList` answers the state of each
   source and the issue rows together, takes a cursor for the next page, and
   `since` or `issueIds` for small updates. It replaces `issuesSources`,
   `issuesSidebarSnapshot` and `issuesLoadMore`.
2. **The issue page is one RPC.** `issuesGet` returns the details and the first
   page of provider history together. `section: 'provider'` stays only for older
   pages of history.
3. **A write does not read again.** Each adapter builds the stored issue from
   the write's own answer. A provider that answers nothing useful is the
   exception, and it is named in the adapter.
4. **No read before a write.** The node id, state id, Project item ids and the
   legal Jira transitions come from the host's copy, which the last read stored.
   A write that fails because the copy is stale reads once and returns the error;
   it does not retry silently.
5. **Refused fields are remembered.** GitHub preview fields and the
   `read:project` scope are checked once for each connection and kept, so a
   refusal is not retried on every read.
6. **One document for several mutations.** GitHub Project field changes, status
   changes and moves across several Projects go in one aliased mutation.

## Work, in order

1. GitHub detail: add `timelineItems(last:100)` to `taskNodeWithMetadata`; drop
   the REST timeline and its second comment read; remember refused variants.
2. `issuesGet` returns history with the details; the client drops its second
   call (`client-core/src/task-data.ts`, mobile `solusIssueActivity`).
3. `issuesList` on the host, desktop, web and mobile; remove the three RPCs it replaces.
4. GitHub writes: build the issue from the PATCH answer; add field `id` and
   single-select `options` to the Project fields of the detail query; aliased
   mutations. Done: an update, a move and a draft update are one write each,
   answered from the host's copy (`current`). The GitHub issue home keeps the
   board items (`boardItems`) and the status permission (`canSetStatus`); the
   repository's planning statuses are kept for ten minutes per connection.
   A copy stored before `boardItems` existed reads them once. Not done: a
   category move of an issue on several Projects is still one mutation for
   each Project; it is rare, and one document needs a batch move on the
   Project source.
5. Jira: one detail call with `expand`; transitions from it; no re-reads.
   Done: the detail read (`expand=changelog,transitions`) carries the newest
   changes as provider metadata and keeps the legal transitions on the Jira
   home. An update is one PUT and a move one POST, answered from the host's
   copy; a copy with no matching transition reads them once. An older history
   page is one changelog read. Provider metadata now names its own
   capabilities, so a section built from it is right for each provider. The
   epic's description is still one more read when the issue has a parent.
6. Linear: merge `readIssue` and `inspectLinearIssue` (with `team.states`);
   cache the organization id and `choices()`; no pre-reads. Done: the detail
   read is one query with the provider section. A write is its mutation; the
   team's states, members and labels are kept for ten minutes per person, and
   a write whose copy lacks the label, member or state it names reads them
   once. A source read always reads them, so its columns are fresh. The
   organization id comes in the same query as the choices, so it needs no
   cache of its own.
7. Lists: pages of 100; GitHub Project `fields` on the first page only; Jira
   statuses and board configuration kept between `loadMore` calls. Done: pages
   of 100 for GitHub and Jira; a GitHub page asks for no more than the cap
   leaves, so a cut page never hides issues behind its cursor. A next page
   gets what the first page gave (`SourceReadHeld`): the Jira project statuses,
   the Jira board's three layout reads and the Linear team read are not read
   again. Not done: the GitHub Project `fields` and the repository's planning
   statuses still come with each page; they are small next to the items, and
   leaving them out needs a directive and a variable in each query variant.

## Verification

Each step has a test that counts provider calls against the fake providers in
`tests/unit/helpers/task-fixtures.ts`, and fails when a step adds a call back.
The GitHub, Jira and Linear changes also need one pass against a real account
of each before they ship, because the fakes do not check query syntax or
permissions.

## Not in scope

- Merging `issuesLinkSession` into `issuesLink`: the two have different access
  rules (the session link checks the caller's access to the session).
- Mobile list refresh on `issues.invalidated`: it re-reads the whole list
  through the T3 list query; narrowing it needs a change to that query.
