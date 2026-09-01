import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { prNavigationTarget } from '@solus/workspace-ui/components/session/lib/pr-navigation'

const root = join(import.meta.dir, '../..')
const sessionSidebar = readFileSync(
  join(root, 'packages/workspace-ui/src/components/session/SessionSidebar.svelte'),
  'utf8',
)
const prChip = readFileSync(
  join(root, 'packages/workspace-ui/src/components/session/PrChip.svelte'),
  'utf8',
)
const sessionSidebarStore = readFileSync(
  join(root, 'packages/workspace-ui/src/contexts/workspace/session-sidebar.store.svelte.ts'),
  'utf8',
)
const gitSection = readFileSync(
  join(root, 'packages/workspace-ui/src/components/project-panel/GitSection.svelte'),
  'utf8',
)
const workspaceContext = readFileSync(
  join(root, 'packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts'),
  'utf8',
)
const pullRequestsContext = readFileSync(
  join(root, 'packages/workspace-ui/src/contexts/prs/pull-requests.context.svelte.ts'),
  'utf8',
)

describe('PR chip navigation', () => {
  it('always opens through the client host in the secondary pane', () => {
    // WHY: neither dispatch placement nor durable task ownership is navigation
    // state. Clicking a chip must stay on the host this client is using.
    expect(prNavigationTarget({
      clientServerId: 'client-host',
      projectDirectory: '/Users/sidhu/solus',
      taskServerId: 'task-host',
      attemptServerId: 'remote-run-host',
    })).toEqual({
      serverId: 'client-host',
      projectDirectory: '/Users/sidhu/solus',
      paneTarget: 'aside',
    })
  })

  it('builds the row\u2019s pull request set in the store, not in the markup', () => {
    // WHY: which pull requests a row stands for is domain state — it reads task
    // links, mounted checkouts and the project index, and two surfaces (the row
    // and its context menu) ask the same question. A component that assembles it
    // inline answers differently from whatever asks next.
    expect(sessionSidebarStore).toContain('prChoicesFor(task: SidebarTask)')
    expect(sessionSidebar).toContain('sidebarStore.prChoicesFor(')
    expect(sessionSidebar).not.toContain('function prChoicesFor(')
    expect(sessionSidebarStore).toContain('this.session.ctxForDirectory(targetScope)')
    expect(sessionSidebar).toContain('target: target.paneTarget')
  })

  it('opens a pull request this client holds no provider record for', () => {
    // WHY: the record comes from the code host and the link comes from our own
    // database. Requiring the record to open a chip is what made a disconnected
    // GitHub empty the sidebar of pull requests that plainly exist — so the
    // fallback to the link's own identity is the behaviour under test.
    expect(sessionSidebar).toContain('session.openPullRequest(choice.pullRequest ?? {')
    expect(sessionSidebar).toContain('number: choice.number')
    expect(sessionSidebar).toContain('choice.url ?? choice.pullRequest?.url')
  })

  it('opens the chip externally on Command-click', () => {
    // WHY: a normal click keeps the review beside the conversation, while the
    // platform link modifier is an explicit request to leave Solus.
    expect(prChip).toContain('if (!event.metaKey || !url) return false;')
    expect(prChip).toContain('void localApi.openExternal(url);')
    expect(prChip).toContain('!openChoiceExternal(choices[0], event)')
  })

  it('uses the same secondary-first rule for View pull request in the Git section', () => {
    // WHY: the full Git row and the compact chip are two presentations of the
    // same action. Neither may bypass Solus while the in-app review can load.
    expect(gitSection).toContain('openPrUrl(primaryAction.url)')
    expect(gitSection).toContain('function openPr(pr: PullRequest)')
    expect(gitSection).toContain('void session.openPullRequest(pr')
    expect(gitSection).toContain('expectedRepo: parsed.baseRepo')
    expect(gitSection).toContain('target: "aside"')
    expect(gitSection).not.toContain('View on GitHub')
    expect(gitSection).not.toContain('Open in review pane')
  })

  it('only a web link waits for the host before it moves a pane', () => {
    // WHY: `prOpenReview` costs seconds. Gating the wait on a fallback URL made
    // every in-app surface block once PR links carried one, so a chip click sat
    // dead until the host answered. Only a transcript link, which can name a
    // repository this client cannot read, may preflight.
    expect(workspaceContext).toContain('if (opts.preflight && opts.externalFallbackUrl) {')
    expect(workspaceContext).toContain('preflight: opts.sourceUrl !== undefined')
    // The external fallback survives the immediate open: a provider refusal
    // after the pane mounts still sends the user to the host.
    expect(workspaceContext).toContain('void localApi.openExternal(opts.externalFallbackUrl)')
  })

  it('has one public PR navigation funnel', () => {
    // WHY: keeping an older open method lets callers silently bypass the
    // secondary-first and external-fallback policy.
    expect(workspaceContext).toContain('async openPullRequest(')
    expect(workspaceContext).not.toContain('async openPrReview(')
  })

  it('keeps PR state in the PR context instead of attaching it to a session', () => {
    // WHY: needs-review, checks, guides, stack topology, and the project index
    // are keyed by host/project or belong to the client view. An agent session
    // can refer to a PR, but it must not become the owner of those objects.
    expect(pullRequestsContext).toContain('readonly projects = new PrsStore()')
    expect(pullRequestsContext).toContain('readonly needsReview = new PrNeedsReviewStore(this.projects)')
    for (const field of ['prs', 'prView', 'prGuides', 'prChecks', 'prNeedsReview', 'stacksStore']) {
      expect(workspaceContext).not.toMatch(new RegExp(`\\n\\s*(?:readonly\\s+)?${field}\\s*=`))
    }
  })
})
