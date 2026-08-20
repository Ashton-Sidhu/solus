import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const rendererRoot = join(import.meta.dir, '../../packages/workspace-ui/src/components')

function readRendererFile(path: string): string {
  return readFileSync(join(rendererRoot, path), 'utf8')
}

const paneSource = readRendererFile('ui/Pane.svelte')
const routeRegistrySource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/contexts/workspace/routing/route-registry.ts'),
  'utf8',
)

describe('loading state while a surface moves between panes', () => {
  test('every workspace page the swap control can move draws a skeleton, not a text label', () => {
    // WHY: moving a surface across remounts it — a new pane id for the outward
    // move, a changed base for the return — so the lazy import is re-awaited on
    // every swap. A centred "Loading…" is what the user reads on each one, and
    // it collapses the page's geometry so the real surface then settles into
    // place. Each route the move can reach must name its own skeleton here.
    const routeSkeletons: [route: string, skeleton: string][] = [
      ['prs', 'PrsPageSkeleton'],
      ['prReview', 'PrReviewSkeleton'],
      ['tasks', 'TasksPageSkeleton'],
      ['task', 'TaskPageSkeleton'],
      ['automations', 'AutomationsPageSkeleton'],
      ['automation', 'AutomationBuilderSkeleton'],
      ['insights', 'InsightsPageSkeleton'],
    ]

    for (const [route, skeleton] of routeSkeletons) {
      expect(paneSource, route).toMatch(
        new RegExp(`ref\\.name === "${route}"\\s*}\\s*<${skeleton} />`),
      )
    }
  })

  test('a work opens with the skeleton for its stored type', () => {
    // WHY: the work route module is lazy too. Falling through to the generic
    // loading label before WorkPane draws its own skeleton produces two loading
    // states in sequence and shifts the whole surface between them.
    expect(paneSource).toMatch(
      /ref\.name === "work"[\s\S]*session\.worksStore\.get\(ref\.params\.workId\)[\s\S]*work\?\.type === "diagram"[\s\S]*<DiagramShellSkeleton \/>[\s\S]*<DocumentModalSkeleton/,
    )
  })

  test('a plan opens with its inline document skeleton', () => {
    // WHY: PlanPane also draws this skeleton, but that module sits behind the
    // route boundary. The outlet must cover the earlier wait with the same UI.
    expect(paneSource).toMatch(
      /ref\.name === "plan"\s*}\s*<PlanModalSkeleton inline \/>/,
    )
  })

  test('every remaining route boundary falls back to a visual skeleton', () => {
    // WHY: route modules do not resolve at the same speed. Any destination
    // left on the old generic label can still show text first and its own
    // skeleton second, even after the common plan and work paths are fixed.
    for (const route of ['folio', 'reviewMode', 'prDiff', 'files', 'fileEditor', 'subagent']) {
      expect(paneSource, route).toContain(`ref.name === "${route}"`)
    }
    expect(paneSource).not.toContain('Loading…')
    expect(paneSource).toContain('<ConversationPaneSkeleton />')
  })

  test('the draft composer does not cross a lazy loading boundary', () => {
    // WHY: a draft already exists in renderer memory when navigation starts.
    // Lazy-loading its surface adds a false loading state to the primary
    // creation path even though there is no data to wait for.
    expect(paneSource).toContain(
      'import SessionDraftPane from "../session-draft/SessionDraftPane.svelte";',
    )
    expect(paneSource).toMatch(
      /{#if ref\?\.name === "draft"}\s*<SessionDraftPane/,
    )
    expect(paneSource).not.toMatch(
      /ref\.name === "draft"[\s\S]*?<ConversationPaneSkeleton/,
    )
    expect(routeRegistrySource).not.toContain(
      "import('../../../components/session-draft/SessionDraftPane.svelte')",
    )
  })

  test('nested pane chunks continue the route skeleton instead of replacing it with text', () => {
    // WHY: Files, the file editor, the PR diff, and sub-agent views each have a
    // second lazy boundary inside their route host. Both boundaries must draw
    // the same loading shape or the duplicate-state flash simply moves inward.
    const files = readRendererFile('files/FilesTreePane.svelte')
    const editor = readRendererFile('files/FileEditorHostPane.svelte')
    const prDiff = readRendererFile('pr-review/PrDiffPane.svelte')
    const subagent = readRendererFile('conversation/SubagentHostPane.svelte')

    expect(files).toMatch(/{#await import\("\.\/FilesPane\.svelte"\)}\s*<FilesRouteSkeleton variant="tree" \/>/)
    expect(editor).toMatch(/{#await import\("\.\/FileEditorPane\.svelte"\)}\s*<FilesRouteSkeleton variant="editor" \/>/)
    expect(prDiff).not.toContain('Loading this pull request…')
    expect(prDiff).toContain('<ReviewLoadingSurface view="diff" />')
    expect(subagent).toMatch(/{#await import\("\.\/SubagentPane\.svelte"\)}\s*<ConversationPaneSkeleton \/>/)
  })

  test('the pill shell draws the same skeletons as the pane outlet', () => {
    // WHY: pill mode reaches the same pages through its own lazy imports. A
    // skeleton wired only into the pane outlet leaves the other shell showing
    // the label this rule exists to remove.
    const pill = readRendererFile('layout/PillLayout.svelte')

    for (const [module, skeleton] of [
      ['../prs/PrsPage.svelte', 'PrsPageSkeleton'],
      ['../tasks/TasksPage.svelte', 'TasksPageSkeleton'],
      ['../automations/AutomationsPage.svelte', 'AutomationsPageSkeleton'],
    ]) {
      expect(pill, module).toMatch(
        new RegExp(`{#await import\\("${module.replace(/[./]/g, '\\$&')}"\\)}\\s*<${skeleton} />`),
      )
    }
    expect(pill).toMatch(
      /{#await import\("\.\.\/workspace\/WorkspacePage\.svelte"\)}\s*<ListPageSkeleton/,
    )
  })

  test('the automation builder covers its store wait as well as its module wait', () => {
    // WHY: the builder has two gates before it can draw — the store fetching the
    // named automation and its own lazy module. The store wait used to render
    // nothing at all, including no PaneChrome, so a pane moved across mid-load
    // showed an empty surface with no way out of it.
    const automationPane = readRendererFile('automations/AutomationPane.svelte')

    expect(automationPane).toMatch(
      /params\.automationId !== null && !automation}\s*<AutomationBuilderSkeleton \/>/,
    )
    expect(automationPane).toMatch(
      /{#await import\("\.\/AutomationBuilder\.svelte"\)}\s*<AutomationBuilderSkeleton \/>/,
    )
    // The chrome sits outside the content branch, so every state can be closed.
    expect(automationPane).toMatch(/{\/if}\s*<!--[\s\S]*?-->\s*<PaneChrome/)
  })

  test("the insights turn detail draws a skeleton when its trace is re-read", () => {
    // WHY: the open turn lives in the route params, so it survives the move and
    // re-fetches its spans in the new pane.
    const turnDetail = readRendererFile('insights/TurnDetailPanel.svelte')
    expect(turnDetail).toMatch(/{#if loading && !view}\s*<TurnDetailSkeleton \/>/)
  })
})
