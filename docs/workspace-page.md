# The Workspace page

The Workspace page is the ledger of every doc, diagram, slide deck, and HTML
artifact this window can read, from every project. Since 2026-10-27 it also
lists what other people shared with the reader, in its own groups.

Where it lives: `packages/workspace-ui/src/components/workspace/`.
`WorkspacePage.svelte` draws it; `lib/workspace-ledger.svelte.ts` holds the open
tab, the filter, the sort, the keyboard cursor, and everything derived from
them; `lib/workspace-items.ts` is the item model. Mobile has no Workspace page.

## Three groups

A tab strip under the page's crumb line names three groups. Each tab carries
its count, and a shared tab carries the faces of the people present in its
records right now.

| Tab | Holds | Groups |
| --- | --- | --- |
| Your works | The reader's own works | Pinned, then Today, Yesterday, This week, then one bucket per month |
| Shared works | Works other people shared with the reader | Needs you (a review request waits), then the date buckets |
| Shared sessions | Sessions other people shared with the reader | Live now (the agent works), then the date buckets |

A record is shared with the reader when the host answered it with a role below
`owner` (`docs/plans/access-model.md` §2.7). The reader's own record carries
`owner`, or no role on a host that is theirs. The session list
(`contexts/workspace/session-list.store.svelte.ts`) keeps each listed session's
role, owner, activity, status, and branch for this.

Every tab reads the Local plus selected organization rule
(`docs/plans/organization-scope.md` §2): a shared tab is empty while no
organization is selected.

Shortcuts: `⌥1`, `⌥2`, `⌥3` open the three tabs. `↑` and `↓` walk the cards,
`⏎` opens the one under the cursor, `Space` peeks a work, `⌥P` pins it.

## Cards

Each record is a card. Three fit across a wide pane, two under 48rem, one under
30rem. A work card shows its kind, its title, the session it came from, and at
the foot who else may open it, who is in it, and when it last moved. The
reader's own card says "Only you", "3 people", "Organization", or "Anyone with
link · 6h left": the widest reach leads. The host answers this with the listing
(`share` on a listed work, `ShareSummary` in `contracts/src/sharing.ts`, from
`ShareManager.accessOf`), and the page reads the listing again on
`share.changed`. A shared work card names who shared it and the reader's role
instead. A session card leads
with the sidebar's own status glyph and the host that runs it, the reader's
role at the right, then the title, the project and branch, the owner, and who
is in it. A session whose host does not answer says "Read only from the mirror".

Opening a shared work opens it as any work. Opening a shared session resumes it
where it runs, as a tab; in the cloud console it opens the session's record.

## Filters

The search field, the sort, and the facets (project, type, time, pinned, needs
my review) apply to the two works tabs. Pinned is the reader's own mark, so its
facet shows only on Your works. The sessions tab keeps the search and the sort.
