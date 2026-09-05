import { join } from 'path'
import { z } from 'zod'
import {
  DEVICE_PRESETS,
  snapshotViewportLabel,
  viewportLabel,
  type BrowserInteractOp,
  type BrowserDiscoveredTarget,
  type BrowserOpenRequest,
  type BrowserOrientation,
  type BrowserPage,
  type BrowserSnapshot,
  type BrowserSnapshotOptions,
  type BrowserEvidenceTarget,
  type BrowserTarget,
  type BrowserViewportRequest,
  type BrowserWebVitals,
} from '@solus/contracts/browser-types'
import type { AgentTool, AgentToolContext, AgentToolResult } from '../agents/tools/agent-tool'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { writeAssetUpload } from '../server/assets'
import { attachEvidence } from './browser-evidence'
import { browserProfiles, profileForOpen } from './browser-profiles'
import { browserRegistry } from './browser-registry'
import { discoverBrowserTargets } from './target-scanner'

/**
 * The agent's half of the browser domain.
 *
 * Every verb addresses a *page*, never an engine, so an agent drives exactly
 * what the user is looking at rather than a private second browser. None of
 * them requires approval: browser browsing is sanctioned infrastructure, which
 * is the amendment to AGENTS.md rule 10 this feature carries (see
 * `docs/plans/cross-platform-visual-qa.md` §7).
 */

const log = createLogger('browser', 'browser-tools.ts')

const PRESET_IDS = DEVICE_PRESETS.map((preset) => preset.id).join(', ')

type BrowserToolFields = NonNullable<AgentTool['inputFields']>

/**
 * How long any browser verb may take before it is treated as never answering.
 *
 * A verb that fails tells the agent something; a verb that hangs tells it
 * nothing, and the turn simply stops — no error, no event, nothing in the
 * transcript. Every individual step below already has its own timeout; this is
 * the backstop that makes "the agent waits forever" unreachable no matter which
 * step is at fault.
 */
const VERB_DEADLINE_MS = 30_000
/** Waiting is this verb's whole job, so it is allowed to outlast the backstop. */
const WAIT_DEADLINE_MS = 90_000

/** Declares one browser verb with its own input type. Nothing here approves:
 *  the whole domain is auto-allowed, so the flag is set once rather than
 *  repeated and eventually mistyped. */
function browserTool<Fields extends BrowserToolFields>(spec: {
  name: string
  description: string
  inputFields: Fields
  deadlineMs?: number
  /** The page this verb works in, when it works in one: the host marks it as in
   *  use for the length of the call (ADR 0024). Declared per verb rather than
   *  sniffed off the input, because `browser_close` carries a page id and is
   *  not use of it. */
  pageOf?: (input: z.output<z.ZodObject<Fields>>) => string
  execute: (
    input: z.output<z.ZodObject<Fields>>,
    context: AgentToolContext,
  ) => Promise<AgentToolResult>
}): AgentTool {
  const deadlineMs = spec.deadlineMs ?? VERB_DEADLINE_MS
  return {
    name: spec.name,
    description: spec.description,
    inputFields: spec.inputFields,
    requiresApproval: false,
    execute: async (input, context) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      // SAFETY: `executeAgentTool` parses the call against these exact fields
      // before dispatching, so this is the tool's own validated input type.
      const parsed = input as z.output<z.ZodObject<Fields>>
      // Released in the `finally` below so a verb that threw or timed out cannot
      // leave the page unclosable. Taken inside the `try`, because
      // `browserRegistry()` throws on a host with no browser domain and that has
      // to reach the agent as a tool result.
      let releaseAgentUse: (() => void) | null = null
      try {
        if (spec.pageOf) {
          releaseAgentUse = browserRegistry()
            .beginAgentUse(spec.pageOf(parsed), spec.name, context.solusSessionId())
        }
        const work = spec.execute(parsed, context)
        return await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(
                `${spec.name} did not finish within ${Math.round(deadlineMs / 1000)}s. `
                + 'The browser guest stopped answering — check the dev server, or reopen the page.',
              )),
              deadlineMs,
            )
          }),
        ])
      } catch (err) {
        return { ok: false, text: err instanceof Error ? err.message : String(err) }
      } finally {
        clearTimeout(timer)
        releaseAgentUse?.()
      }
    },
  }
}

function ok(text: string): AgentToolResult {
  return { ok: true, text }
}

function fail(text: string): AgentToolResult {
  return { ok: false, text }
}

/** Which size the caller asked for. A preset wins when both are given: it
 *  carries touch and pixel ratio the two numbers cannot. */
function viewportRequestFrom(input: {
  preset?: string | undefined
  orientation?: BrowserOrientation | undefined
  width?: number | undefined
  height?: number | undefined
  touch?: boolean | undefined
}): BrowserViewportRequest | null {
  if (input.preset) {
    return { mode: 'preset', presetId: input.preset, orientation: input.orientation ?? 'portrait' }
  }
  if (input.width !== undefined && input.height !== undefined) {
    return { mode: 'custom', width: input.width, height: input.height, hasTouch: input.touch ?? false }
  }
  return null
}

function describePage(page: BrowserPage): string {
  const viewport = `${page.viewport.width}×${page.viewport.height} @${page.viewport.deviceScaleFactor}x `
    + `(${viewportLabel(page.viewport)}, ${page.viewport.orientation}`
    + `${page.viewport.hasTouch ? ', touch' : ''})`
  const lines = [
    `${page.browserPageId} — ${page.label}`,
    `  url: ${page.url || '(none)'}${page.title ? ` — ${page.title}` : ''}`,
    `  viewport: ${viewport}`,
    `  appearance: ${page.appearance}   host: ${page.hostKind}   state: ${page.loadState}`,
    `  profile: ${page.profileId}`,
  ]
  if (page.problem) lines.push(`  problem: ${page.problem.kind} — ${page.problem.message}`)
  // The one page state that makes every other verb fail, so it is stated where
  // an agent reads the page rather than discovered by a refused command.
  if (page.devToolsOpen) {
    lines.push('  devtools: open — the user is inspecting this page, so it cannot be driven until they close it')
  }
  return lines.join('\n')
}

export const browserStatusAgentTool = browserTool({
  name: 'browser_status',
  description:
    'List the open browser pages and the running dev servers this host discovered as browser targets. '
    + 'Start here: a page you can already drive is faster than opening a new one. It also lists the '
    + 'browser profiles each project has: a project can hold several signed-in identities, and a page '
    + 'opens as one of them.',
  inputFields: {},
  execute: async () => {
    const pages = browserRegistry().list()
    const targets = await discoverBrowserTargets()
    return ok([
      pages.length
        ? `Open browser pages:\n${pages.map(describePage).join('\n')}`
        : 'No browser pages are open.',
      targets.length
        ? `Discovered dev servers:\n${targets
          .map((target) => `  ${target.url}${target.branch ? ` — ${target.branch}` : ''}${target.title ? ` — ${target.title}` : ''}`)
          .join('\n')}`
        : 'No running dev servers were discovered. Solus does not start them; start one in your own shell first.',
      describeProfiles(targets),
      `Device presets: ${PRESET_IDS}`,
    ].filter(Boolean).join('\n\n'))
  },
})

/**
 * The profiles the projects behind the discovered targets have.
 *
 * Taken off the scan rather than from a parameter, for the same reason
 * attribution is: the agent knows a URL, and the host knows which project serves
 * it and which identities that project has signed in. A project with only its
 * automatic profile is left out — there is nothing there to choose between.
 */
function describeProfiles(targets: BrowserDiscoveredTarget[]): string {
  const roots = [...new Set(targets.flatMap((target) => (target.projectRoot ? [target.projectRoot] : [])))]
  const lines: string[] = []
  for (const root of roots) {
    const set = browserProfiles(root)
    if (set.profiles.length <= 1) continue
    lines.push(
      `  ${root}: ${set.profiles
        .map((profile) => `${profile.id}${profile.id === set.defaultProfileId ? ' (default)' : ''} - ${profile.name}`)
        .join(', ')}`,
    )
  }
  return lines.length ? `Browser profiles:\n${lines.join('\n')}` : ''
}

export const browserOpenAgentTool = browserTool({
  name: 'browser_open',
  description:
    'Open a browser page on a URL. It fills the pane showing it unless you name a device preset. '
    + 'The page is rendered on this host and is yours to drive whether or not anyone is looking at '
    + 'it, so opening one to check something puts nothing on the user\'s screen. Pass show: true only '
    + 'when the user asked to look at the page themselves.',
  inputFields: {
    url: z.string().describe('The dev-server URL to browser, e.g. http://localhost:5173/'),
    preset: z.string().optional().describe(
      `Device preset id, when the check is about a device. One of: ${PRESET_IDS}. Omit to fill the pane.`,
    ),
    orientation: z.enum(['portrait', 'landscape']).optional(),
    appearance: z.enum(['system', 'light', 'dark']).optional(),
    label: z.string().optional().describe('Page-strip label. Defaults to the worktree branch or the port.'),
    show: z.boolean().optional().describe(
      'Put the page in front of the user, opening their browser pane. Default false. Only when they '
      + 'asked to see it — a page you opened to verify something is not something they asked for.',
    ),
    profile: z.string().optional().describe(
      'Browser profile id, when the check is about a particular signed-in identity — a project can '
      + 'have several. browser_status lists the ids. Omit to use the project\'s chosen default.',
    ),
  },
  execute: async (input, context) => {
    // Attribution comes off the scan rather than the caller: the agent knows a
    // URL, the host knows which worktree is serving it.
    const match = (await discoverBrowserTargets()).find((found) => samePort(found.url, input.url))
    const target: BrowserTarget = { kind: 'url', url: input.url }
    if (match?.worktreePath) target.worktreePath = match.worktreePath
    if (match?.branch) target.branch = match.branch
    if (match?.projectRoot) target.projectRoot = match.projectRoot

    // Asking for a surface takes over the user's pane and pins the page to the
    // client's `<webview>`. Both were unavoidable before the headless host
    // existed — a page with no surface could not be driven at all — and both are
    // now costs paid for nothing unless the user actually wants to look.
    const request: BrowserOpenRequest = { target, requestSurface: input.show === true }
    if (input.preset) request.presetId = input.preset
    if (input.orientation) request.orientation = input.orientation
    if (input.appearance) request.appearance = input.appearance
    if (input.label) request.label = input.label
    // The project's chosen default when the agent named none, and a refusal when
    // it named one this project does not have — resolved before the page exists.
    request.profileId = profileForOpen(target.projectRoot, input.profile)

    const page = browserRegistry().open(request)
    browserRegistry().noteAgentUse(page.browserPageId, 'browser_open', context.solusSessionId())
    return ok(`${describePage(page)}\n\nUse browser_snapshot with this browserPageId to see it.`)
  },
})

export const browserCloseAgentTool = browserTool({
  name: 'browser_close',
  description: 'Close a browser page. Do this for pages you opened and no longer need.',
  inputFields: { browserPageId: z.string() },
  execute: async (input, context) => {
    // No `pageOf`: tidying up a page is not use of it. The close is forced when
    // the page is this session's own — asking a user to confirm an agent's own
    // cleanup would be a prompt about nothing — and refused when another
    // session is in the middle of driving it.
    const registry = browserRegistry()
    const user = registry.get(input.browserPageId)?.agentUse?.sessionId
    const own = !user || user === context.solusSessionId()
    const result = await registry.close(input.browserPageId, { force: own })
    if (!result.closed) {
      return fail(`Another session is ${result.agentUse.verb} on ${input.browserPageId} right now. Leave it open.`)
    }
    return ok(`Closed ${input.browserPageId}.`)
  },
})

export const browserNavigateAgentTool = browserTool({
  name: 'browser_navigate',
  description: 'Move a browser page: go to a URL, go back or forward, or reload.',
  inputFields: {
    browserPageId: z.string(),
    action: z.enum(['goto', 'back', 'forward', 'reload']),
    url: z.string().optional().describe('Required when action is "goto".'),
  },
  pageOf: (input) => input.browserPageId,
  execute: async (input) => {
    if (input.action === 'goto' && !input.url) return fail('browser_navigate with "goto" requires a url.')
    await browserRegistry().navigate(
      input.browserPageId,
      input.action === 'goto' ? { kind: 'goto', url: input.url ?? '' } : { kind: input.action },
    )
    return ok(`Navigated ${input.browserPageId} (${input.action}).`)
  },
})

export const browserResizeAgentTool = browserTool({
  name: 'browser_resize',
  description:
    'Put a browser page at another viewport, by device preset or by exact size. A preset is real device '
    + 'emulation — touch, device pixel ratio, and user agent change with it, so mobile layouts behave as '
    + 'they do on the device. An exact width and height is the way to check a specific breakpoint.',
  inputFields: {
    browserPageId: z.string(),
    preset: z.string().optional().describe(`One of: ${PRESET_IDS}. Omit when giving width and height.`),
    orientation: z.enum(['portrait', 'landscape']).optional().describe('Preset only.'),
    width: z.number().optional().describe('CSS pixels. Use with height for a size no preset covers.'),
    height: z.number().optional(),
    touch: z.boolean().optional().describe('Emulate touch at a custom size. Default false.'),
  },
  pageOf: (input) => input.browserPageId,
  execute: async (input) => {
    const request = viewportRequestFrom(input)
    if (!request) return fail('browser_resize needs either a preset, or both width and height.')
    await browserRegistry().setViewport(input.browserPageId, request)
    const page = browserRegistry().get(input.browserPageId)
    return ok(page ? describePage(page) : `Resized ${input.browserPageId}.`)
  },
})

export const browserAppearanceAgentTool = browserTool({
  name: 'browser_set_appearance',
  description: 'Force a browser page into light or dark mode, or follow the system, via emulated media.',
  inputFields: { browserPageId: z.string(), appearance: z.enum(['system', 'light', 'dark']) },
  pageOf: (input) => input.browserPageId,
  execute: async (input) => {
    await browserRegistry().setAppearance(input.browserPageId, input.appearance)
    return ok(`${input.browserPageId} is now rendering as ${input.appearance}.`)
  },
})

export const browserSnapshotAgentTool = browserTool({
  name: 'browser_snapshot',
  description:
    'See a browser page: a screenshot written to a file you can Read, the interactive elements with '
    + 'their refs and Svelte source locations, and the console and network history the page has '
    + 'accumulated, plus the page\'s Web Vitals (TTFB, FCP, LCP, CLS) so a layout that looks right '
    + 'but paints slowly is visible too. This is how you verify a UI change at a viewport instead of guessing. The user '
    + 'sees the screenshot in the conversation as soon as you take it, so report what you found '
    + 'rather than narrating the picture. Pass attach_to_task_id or attach_to_pr_number to file the '
    + 'capture where it will outlive this session — a UI change needs before/after images on its '
    + 'pull request, and this is how they get there.',
  inputFields: {
    browserPageId: z.string(),
    screenshot: z.boolean().optional().describe('Default true. Set false for structure only.'),
    maxElements: z.number().optional().describe('Cap on returned elements. Default 120.'),
    attach_to_task_id: z.string().optional().describe(
      'File the capture as a comment on this task. It renders inline in Solus and stays local.',
    ),
    attach_to_pr_number: z.number().optional().describe(
      'File the capture as a comment on this pull request. The image is published to the repository '
      + 'first, because a pull request cannot render a Solus-local asset.',
    ),
    caption: z.string().optional().describe('What the capture shows. Defaults to the page and its viewport.'),
  },
  pageOf: (input) => input.browserPageId,
  execute: async (input, context) => {
    const options: BrowserSnapshotOptions = {}
    if (input.screenshot !== undefined) options.screenshot = input.screenshot
    if (input.maxElements !== undefined) options.maxElements = input.maxElements
    const snapshot = await browserRegistry().snapshot(input.browserPageId, options)
    const { text, assetId } = await renderSnapshot(snapshot)
    // Filing happens against the asset the snapshot already wrote, never a
    // second capture: two pictures of "the same" moment are two moments.
    const filed = assetId ? await fileCapture(input, assetId, snapshot, context) : null
    // The capture is published to the conversation here rather than left to the
    // agent's reply. A visual check the person who asked for it cannot see is
    // half a check, and asking the model to remember to paste a link would make
    // whether they see it depend on the model.
    if (assetId) {
      context.emit({
        type: 'browser_snapshot_captured',
        snapshot: {
          browserPageId: snapshot.browserPageId,
          assetId,
          url: snapshot.url,
          title: snapshot.title,
          viewport: snapshotViewportLabel(snapshot.viewport),
          appearance: snapshot.appearance,
          elementCount: snapshot.elements.length,
          consoleErrors: snapshot.console.filter((entry) => entry.level === 'error').length,
          capturedAt: snapshot.capturedAt,
        },
      })
    }
    return ok(filed ? `${text}\n\n${filed}` : text)
  },
})

/**
 * File a snapshot the caller asked to keep.
 *
 * A failed attach must not fail the snapshot: the agent looked at the page, and
 * that answer is still worth having. The problem is reported in the result text
 * instead, where the agent can act on it — usually by connecting GitHub.
 */
async function fileCapture(
  input: { attach_to_task_id?: string | undefined; attach_to_pr_number?: number | undefined; caption?: string | undefined },
  assetId: string,
  snapshot: BrowserSnapshot,
  context: AgentToolContext,
): Promise<string | null> {
  const target = evidenceTargetFrom(input, context)
  if (!target) return null
  const page = browserRegistry().get(snapshot.browserPageId)
  if (!page) return 'The browser page closed before the capture could be filed.'
  try {
    const attached = await attachEvidence(assetId, target, { page, caption: input.caption })
    return `Filed on ${attached.attachedTo}.${attached.publishedUrl ? ` Published at ${attached.publishedUrl}` : ''}`
  } catch (error) {
    return `The capture was stored but not filed: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** A pull request is addressed by number plus the checkout it belongs to — the
 *  session's own working directory, because that is the one the agent is in. */
function evidenceTargetFrom(
  input: { attach_to_task_id?: string | undefined; attach_to_pr_number?: number | undefined },
  context: AgentToolContext,
): BrowserEvidenceTarget | null {
  if (input.attach_to_task_id) return { kind: 'task', taskId: input.attach_to_task_id }
  if (input.attach_to_pr_number) return { kind: 'pr', number: input.attach_to_pr_number, cwd: context.cwd }
  return null
}

export const browserClickAgentTool = browserTool({
  name: 'browser_click',
  description: 'Click an element in a browser page, named by a ref from browser_snapshot.',
  inputFields: {
    browserPageId: z.string(),
    ref: z.string().describe('An element ref from browser_snapshot, e.g. [data-solus-browser-ref="e4"].'),
  },
  pageOf: (input) => input.browserPageId,
  execute: async (input) => interact(input.browserPageId, { kind: 'click', ref: input.ref }),
})

export const browserTypeAgentTool = browserTool({
  name: 'browser_type',
  description: 'Type text into a field in a browser page.',
  inputFields: {
    browserPageId: z.string(),
    ref: z.string().describe('An element ref from browser_snapshot.'),
    text: z.string(),
    clear: z.boolean().optional().describe('Empty the field first. Default false.'),
  },
  pageOf: (input) => input.browserPageId,
  execute: async (input) => {
    const op: BrowserInteractOp = { kind: 'type', ref: input.ref, text: input.text }
    if (input.clear !== undefined) op.clear = input.clear
    return interact(input.browserPageId, op)
  },
})

export const browserPressAgentTool = browserTool({
  name: 'browser_press',
  description:
    'Press a key in a browser page — Enter, Tab, Escape, Backspace, Delete, or an Arrow key. '
    + 'Solus is keyboard-first, so this is how you verify a shortcut actually works.',
  inputFields: { browserPageId: z.string(), key: z.string() },
  pageOf: (input) => input.browserPageId,
  execute: async (input) => interact(input.browserPageId, { kind: 'press', key: input.key }),
})

export const browserScrollAgentTool = browserTool({
  name: 'browser_scroll',
  description: 'Scroll a browser page, or a scrollable element inside it, by a pixel delta.',
  inputFields: {
    browserPageId: z.string(),
    deltaY: z.number().describe('Positive scrolls down.'),
    ref: z.string().optional().describe('Scroll over this element instead of the page centre.'),
  },
  pageOf: (input) => input.browserPageId,
  execute: async (input) => {
    const op: BrowserInteractOp = { kind: 'scroll', deltaY: input.deltaY }
    if (input.ref) op.ref = input.ref
    return interact(input.browserPageId, op)
  },
})

export const browserEvaluateAgentTool = browserTool({
  name: 'browser_evaluate',
  description:
    'Evaluate a JavaScript expression inside a browser page and return its JSON value. Use it to read '
    + 'computed styles, element counts, or app state that a screenshot cannot show.',
  inputFields: {
    browserPageId: z.string(),
    expression: z.string().describe('A JavaScript expression, not a statement list.'),
  },
  pageOf: (input) => input.browserPageId,
  execute: async (input) => interact(input.browserPageId, { kind: 'evaluate', expression: input.expression }),
})

export const browserWaitForAgentTool = browserTool({
  name: 'browser_wait_for',
  description:
    'Poll a JavaScript expression in a browser page until it is truthy. Use this instead of sleeping '
    + 'after an interaction that loads or animates.',
  inputFields: {
    browserPageId: z.string(),
    expression: z.string(),
    timeoutMs: z.number().optional().describe('Default 5000.'),
  },
  deadlineMs: WAIT_DEADLINE_MS,
  pageOf: (input) => input.browserPageId,
  execute: async (input) => {
    const op: BrowserInteractOp = { kind: 'waitFor', expression: input.expression }
    if (input.timeoutMs !== undefined) op.timeoutMs = input.timeoutMs
    return interact(input.browserPageId, op)
  },
})

async function interact(browserPageId: string, op: BrowserInteractOp): Promise<AgentToolResult> {
  const result = await browserRegistry().interact(browserPageId, op)
  if (!result.ok) return fail(result.message ?? 'The browser page rejected that operation.')
  return ok(result.value ? `ok — ${result.value}` : 'ok')
}

/**
 * A snapshot as an agent should receive it: the image on disk — so it can be
 * read as an image rather than pasted into the transcript as base64 — and the
 * structure inline. The asset store is the same one evidence publishes from.
 *
 * The stored id comes back with the text because the conversation needs it too:
 * the caller publishes it so the user sees the same capture the agent did.
 */
async function renderSnapshot(
  snapshot: BrowserSnapshot,
): Promise<{ text: string; assetId: string | null }> {
  const lines: string[] = [
    `${snapshot.url} — ${snapshot.title || '(untitled)'}`,
    `viewport ${snapshot.viewport.width}×${snapshot.viewport.height} @${snapshot.viewport.deviceScaleFactor}x `
    + `(${viewportLabel(snapshot.viewport)}, ${snapshot.viewport.orientation}), appearance ${snapshot.appearance}`,
  ]
  let assetId: string | null = null

  if (snapshot.screenshot) {
    // Logged like the registry's own stages: this write is the last thing a
    // snapshot does, so without a line here a stall in the asset store looks
    // exactly like a stall in the capture.
    const startedAt = Date.now()
    const stored = await writeAssetUpload({
      name: `browser-${snapshot.browserPageId}.png`,
      mime: 'image/png',
      dataUrl: snapshot.screenshot,
    })
    log.debug('browser_snapshot_stage', {
      browserPageId: snapshot.browserPageId,
      stage: 'asset',
      detail: stored.id,
      ms: Date.now() - startedAt,
    })
    assetId = stored.id
    // The path is for the agent, which reads it as an image. The user gets the
    // same capture as a card in the conversation, published by the caller — so
    // nothing here asks the model to remember to show it.
    lines.push(`screenshot: ${join(dataDir(), 'assets', stored.id)}  (read this path to look at it)`)
  }

  // Between the picture and the structure on purpose: a page can look correct
  // and take four seconds to paint, and the numbers that say so are the ones a
  // screenshot can never carry.
  const vitals = snapshot.vitals ? describeVitals(snapshot.vitals) : ''
  if (vitals) lines.push(`web vitals: ${vitals}`)

  lines.push('', `elements (${snapshot.elements.length}):`)
  for (const element of snapshot.elements) {
    const source = element.source ? `  ${element.source.file}:${element.source.line}` : ''
    const identifier = element.identifier ? ` #${element.identifier}` : ''
    lines.push(
      `  ${element.ref} ${element.role}${identifier} "${element.label}" `
      + `@${element.rect.x},${element.rect.y} ${element.rect.width}×${element.rect.height}${source}`,
    )
  }

  const loud = snapshot.console.filter((entry) => entry.level === 'error' || entry.level === 'warn')
  if (loud.length) {
    lines.push('', `console (${loud.length} warnings/errors of ${snapshot.console.length} entries):`)
    for (const entry of loud.slice(-20)) lines.push(`  [${entry.level}] ${entry.text}`)
  }

  const failures = snapshot.network.filter((entry) => entry.failure || entry.status >= 400)
  if (failures.length) {
    lines.push('', `network failures (${failures.length}):`)
    for (const entry of failures.slice(-20)) {
      lines.push(`  ${entry.status || '-'} ${entry.url || '(unknown)'}${entry.failure ? ` — ${entry.failure}` : ''}`)
    }
  }

  return { text: lines.join('\n'), assetId }
}

/**
 * The page's load timings, in the vocabulary an agent already knows.
 *
 * Named metrics rather than raw fields, because "LCP 2400ms" is a fact the model
 * can weigh against a published threshold while "largestContentfulPaint: 2400"
 * is a number it has to be told the meaning of. Absent metrics are simply left
 * out — a page still loading has no load time, and printing a zero would be a
 * measurement nobody took.
 */
function describeVitals(vitals: BrowserWebVitals): string {
  const parts: string[] = []
  if (vitals.ttfbMs !== undefined) parts.push(`TTFB ${vitals.ttfbMs}ms`)
  if (vitals.fcpMs !== undefined) parts.push(`FCP ${vitals.fcpMs}ms`)
  if (vitals.lcpMs !== undefined) parts.push(`LCP ${vitals.lcpMs}ms`)
  if (vitals.cls !== undefined) parts.push(`CLS ${vitals.cls}`)
  if (vitals.loadMs !== undefined) parts.push(`load ${vitals.loadMs}ms`)
  return parts.join(', ')
}

/** Two URLs name the same dev server when they name the same port — which is
 *  what `localhost` versus `127.0.0.1` versus a LAN address all come down to. */
function samePort(a: string, b: string): boolean {
  try {
    return new URL(a).port === new URL(b).port
  } catch {
    return false
  }
}
