/**
 * The browser domain: viewing and driving a running UI at a chosen viewport.
 *
 * Vocabulary is locked by `docs/plans/cross-platform-visual-qa.md`:
 * - **browser page** — the unit (`BrowserPage`, `browserPageId`).
 * - **target** — what a page shows.
 * - **host** — the backend rendering it (webview today, headless later).
 * - **surface** — the client component displaying it.
 * - **stage** — the letterboxed viewport chrome around the surface.
 * - **snapshot** — the agent-facing capture.
 *
 * A page's durable state lives on the server so an agent can address it whether
 * or not a client is looking. What the client owns is the surface.
 */

/** A viewport the user or an agent can ask for, by name. */
export interface DevicePreset {
  id: string
  label: string
  /** Portrait CSS pixels. A rotated page swaps these. */
  width: number
  height: number
  deviceScaleFactor: number
  /** Drives real touch emulation, not just a narrow box: `pointer: coarse` and
   *  touch events actually fire, which is the whole point of testing mobile. */
  hasTouch: boolean
  /** Absent means "keep the host browser's own agent" — correct for desktop. */
  userAgent?: string
  group: 'phone' | 'tablet' | 'desktop'
}

const IOS_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const IPAD_USER_AGENT =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

/**
 * The named viewports, in Chrome DevTools' device order. Dimensions are CSS
 * viewport sizes from Chromium's own emulated-device catalog.
 *
 * The catalog is a convenience, not the limit: any size at all is reachable
 * through `custom` mode, so a device missing here costs the user two numbers
 * rather than a code change.
 */
export const DEVICE_PRESETS: readonly DevicePreset[] = [
  {
    id: 'iphone-se',
    label: 'iPhone SE',
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    hasTouch: true,
    userAgent: IOS_USER_AGENT,
    group: 'phone',
  },
  {
    id: 'iphone-12-pro',
    label: 'iPhone 12 Pro',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    hasTouch: true,
    userAgent: IOS_USER_AGENT,
    group: 'phone',
  },
  {
    id: 'iphone-15',
    label: 'iPhone 15',
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    hasTouch: true,
    userAgent: IOS_USER_AGENT,
    group: 'phone',
  },
  {
    id: 'iphone-15-pro-max',
    label: 'iPhone 15 Pro Max',
    width: 430,
    height: 932,
    deviceScaleFactor: 3,
    hasTouch: true,
    userAgent: IOS_USER_AGENT,
    group: 'phone',
  },
  {
    id: 'pixel-8',
    label: 'Pixel 8',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    hasTouch: true,
    userAgent: ANDROID_USER_AGENT,
    group: 'phone',
  },
  {
    id: 'galaxy-s20-ultra',
    label: 'Galaxy S20 Ultra',
    width: 412,
    height: 915,
    deviceScaleFactor: 3.5,
    hasTouch: true,
    userAgent: ANDROID_USER_AGENT,
    group: 'phone',
  },
  {
    id: 'galaxy-z-fold-5',
    label: 'Galaxy Z Fold 5',
    width: 344,
    height: 882,
    deviceScaleFactor: 2.625,
    hasTouch: true,
    userAgent: ANDROID_USER_AGENT,
    group: 'phone',
  },
  {
    id: 'ipad-mini',
    label: 'iPad mini',
    width: 744,
    height: 1133,
    deviceScaleFactor: 2,
    hasTouch: true,
    userAgent: IPAD_USER_AGENT,
    group: 'tablet',
  },
  {
    id: 'ipad-air',
    label: 'iPad Air',
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    hasTouch: true,
    userAgent: IPAD_USER_AGENT,
    group: 'tablet',
  },
  {
    id: 'ipad-pro-11',
    label: 'iPad Pro 11"',
    width: 834,
    height: 1194,
    deviceScaleFactor: 2,
    hasTouch: true,
    userAgent: IPAD_USER_AGENT,
    group: 'tablet',
  },
  {
    id: 'surface-pro-7',
    label: 'Surface Pro 7',
    width: 912,
    height: 1368,
    deviceScaleFactor: 2,
    hasTouch: true,
    group: 'tablet',
  },
  {
    id: 'small-laptop',
    label: 'Small laptop',
    width: 1280,
    height: 800,
    deviceScaleFactor: 2,
    hasTouch: false,
    group: 'desktop',
  },
  {
    id: 'laptop',
    label: 'Laptop',
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    hasTouch: false,
    group: 'desktop',
  },
  {
    // The logical resolution a MacBook Pro reports at its default scaling, which
    // is what a page actually lays out against — not the panel's pixel count.
    id: 'macbook-pro-15',
    label: 'MacBook Pro 15"',
    width: 1512,
    height: 982,
    deviceScaleFactor: 2,
    hasTouch: false,
    group: 'desktop',
  },
  {
    id: 'desktop',
    label: 'Desktop',
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    hasTouch: false,
    group: 'desktop',
  },
  {
    id: 'desktop-large',
    label: 'Large desktop',
    width: 2560,
    height: 1440,
    deviceScaleFactor: 1,
    hasTouch: false,
    group: 'desktop',
  },
]

export function presetById(id: string): DevicePreset | undefined {
  return DEVICE_PRESETS.find((preset) => preset.id === id)
}

export type BrowserOrientation = 'portrait' | 'landscape'

/** What the guest is told the OS colour scheme is. */
export type BrowserAppearance = 'system' | 'light' | 'dark'

/**
 * How a page's size was decided.
 *
 * - `preset` — a named device, with its real pixel ratio, touch and user agent.
 * - `custom` — any width and height the user or an agent asked for. This is what
 *   makes an arbitrary breakpoint testable without shipping a device for it.
 * - `fill` — the page takes the size of the stage showing it, and keeps taking
 *   it as the pane is dragged. The client measures; the page still records the
 *   resulting numbers, so an agent reads a real viewport rather than "fill".
 */
export type BrowserViewportMode = 'preset' | 'custom' | 'fill'

/** Bounds on any size a page can be asked for. Below the floor nothing lays
 *  out; above the ceiling the guest's own backing store is the problem. */
export const BROWSER_MIN_DIMENSION = 120
export const BROWSER_MAX_DIMENSION = 3840

export function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return BROWSER_MIN_DIMENSION
  return Math.min(BROWSER_MAX_DIMENSION, Math.max(BROWSER_MIN_DIMENSION, Math.round(value)))
}

/** The resolved CSS viewport a page is emulating right now. */
export interface BrowserViewport {
  mode: BrowserViewportMode
  /** Set in `preset` mode only — the other modes are not any named device. */
  presetId?: string
  orientation: BrowserOrientation
  width: number
  height: number
  deviceScaleFactor: number
  hasTouch: boolean
}

/** What a caller asks for. The resolved viewport is derived from it, never sent
 *  by the caller, so every host agrees on what a request means. */
export type BrowserViewportRequest =
  | { mode: 'preset'; presetId: string; orientation?: BrowserOrientation }
  | { mode: 'custom'; width: number; height: number; hasTouch?: boolean }
  | { mode: 'fill'; width: number; height: number }

export function viewportFor(
  preset: DevicePreset,
  orientation: BrowserOrientation,
): BrowserViewport {
  const rotated = orientation === 'landscape'
  return {
    mode: 'preset',
    presetId: preset.id,
    orientation,
    width: rotated ? preset.height : preset.width,
    height: rotated ? preset.width : preset.height,
    deviceScaleFactor: preset.deviceScaleFactor,
    hasTouch: preset.hasTouch,
  }
}

/**
 * Resolve a request into the viewport a page will emulate.
 *
 * A sized mode keeps a pixel ratio of 1: the user asked for a rectangle, not for
 * a device, and inventing a retina ratio for it would make screenshots twice the
 * size they were asked for. Touch stays off unless it was requested, because a
 * narrow desktop window is not a phone.
 */
export function resolveViewport(request: BrowserViewportRequest): BrowserViewport {
  if (request.mode === 'preset') {
    const preset = presetById(request.presetId)
    if (!preset) throw new Error(`Unknown device preset: ${request.presetId}`)
    return viewportFor(preset, request.orientation ?? 'portrait')
  }
  const width = clampDimension(request.width)
  const height = clampDimension(request.height)
  return {
    mode: request.mode,
    orientation: width > height ? 'landscape' : 'portrait',
    width,
    height,
    deviceScaleFactor: 1,
    hasTouch: request.mode === 'custom' ? (request.hasTouch ?? false) : false,
  }
}

/**
 * What a page opens at: the space it is given.
 *
 * A device is a deliberate act of QA, so nothing picks one on the user's behalf
 * — the page is simply as big as the pane until someone asks for a preset or a
 * size, and it stays that way afterwards. These numbers are provisional: the
 * first client to measure its stage replaces them, and a page nothing has
 * rendered yet reports the size an agent would get from a desktop pane.
 */
export function defaultViewport(): BrowserViewport {
  return resolveViewport({ mode: 'fill', width: 1280, height: 800 })
}

/** How the current size reads in the toolbar and in an agent's page summary. */
export function viewportLabel(viewport: BrowserViewport): string {
  if (viewport.mode === 'fill') return 'Fill pane'
  if (viewport.mode === 'custom') return 'Custom'
  const preset = viewport.presetId ? presetById(viewport.presetId) : undefined
  return preset?.label ?? viewport.presetId ?? 'Custom'
}

/**
 * What a page shows. `device` (simulator/emulator) is declared here so the agent
 * verb set never forks per platform; its adapter arrives with P4.
 */
export type BrowserTarget =
  | { kind: 'url'; url: string; worktreePath?: string; branch?: string; projectRoot?: string }
  | { kind: 'device'; deviceId: string; platform: 'ios' | 'android' }

/**
 * Which backend is rendering a page.
 * - `webview` — a desktop client's Electron `<webview>`; native interaction.
 * - `headless` — a server-side browser; agents with no client attached (P2).
 * - `none` — the page exists but nothing is rendering it, so drive ops fail
 *   loudly instead of silently doing nothing.
 */
export type BrowserHostKind = 'webview' | 'headless' | 'none'

export type BrowserLoadState = 'idle' | 'loading' | 'ready' | 'failed'

export interface BrowserConsoleEntry {
  at: number
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
  /** Where the guest raised it, when the runtime says. */
  source?: string
}

export interface BrowserNetworkEntry {
  at: number
  method: string
  url: string
  status: number
  /** Absent when the response never arrived (aborted, offline, blocked). */
  failure?: string
}

/** How much retroactive console/network history a page keeps. Bounded because
 *  it ships to clients and into agent snapshots. */
export const BROWSER_RING_LIMIT = 200

/**
 * The durable state of one browser page. Server-owned; clients mirror it and
 * agents address it. Nothing here is a live handle — the surface and the host's
 * browser objects stay on their own side of the boundary.
 */
export interface BrowserPage {
  browserPageId: string
  target: BrowserTarget
  /** Where the page actually is, which drifts from the target as the user browses. */
  url: string
  title: string
  viewport: BrowserViewport
  appearance: BrowserAppearance
  hostKind: BrowserHostKind
  loadState: BrowserLoadState
  /** Set while `loadState` is `failed`, or while the target port is not listening. */
  problem?: BrowserProblem
  canGoBack: boolean
  canGoForward: boolean
  /**
   * Chromium's own DevTools are open on this guest.
   *
   * It is page state rather than client state because of what it costs: DevTools
   * and Solus's CDP session are exclusive, so while this is true nothing can
   * drive, snapshot, or stream the page. Every surface and every agent has to be
   * able to see that, not just the window that opened it.
   */
  devToolsOpen: boolean
  /** Which annotation tool is armed, or null when the user is not annotating. */
  annotationTool: BrowserAnnotationTool | null
  /** Label for the page strip — the worktree branch when the target has one. */
  label: string
  createdAt: number
}

/**
 * How the user points at something in the page.
 *
 * - `select` — the page, untouched. The overlay stays up and stops swallowing
 *   the pointer, so a flow can be clicked through without leaving the marks or
 *   losing the tools. It produces no annotations of its own.
 * - `pick` — hover-highlight and click one element, which carries its Svelte
 *   source location and so names a file rather than a screenshot region.
 * - `region` — drag a box that selects every visible element fully inside it.
 * - `draw` — freehand, for the circle-and-underline gesture a person makes.
 * - `erase` — click an annotation to remove it. Produces none of its own.
 */
export const BROWSER_ANNOTATION_TOOLS = [
  'select',
  'pick',
  'region',
  'draw',
  'erase',
] as const

export type BrowserAnnotationTool = (typeof BROWSER_ANNOTATION_TOOLS)[number]

/**
 * The tools that leave a mark behind.
 *
 * A runtime list rather than only a type, because the server validates what the
 * guest reports against it. Held here so the two cannot drift: a tool added to
 * the union above and not to the validator makes every mark on the page vanish
 * — the array parse fails whole, so one unrecognised mark discards the box and
 * the drawing beside it.
 */
export const BROWSER_MARK_TOOLS = ['pick', 'region', 'draw'] as const

/**
 * One thing the user pointed at, in the page's own coordinates.
 *
 * These live in the guest, not in the client: the overlay that captures them is
 * injected into the page, which is what makes one implementation serve the
 * native `<webview>` and the streamed canvas at once — and what puts the marks
 * inside any capture taken while they are up.
 */
export interface BrowserAnnotation {
  id: string
  /** `select` and `erase` are absent because neither leaves a mark: one hands
   *  the pointer back to the page, the other takes marks away. */
  tool: (typeof BROWSER_MARK_TOOLS)[number]
  /** CSS-pixel rect in the page's viewport. For `draw`, the stroke's bounds;
   *  for `region`, the bounds of the elements the box selected. */
  rect: { x: number; y: number; width: number; height: number }
  /** The sampled points of a freehand `draw` stroke. */
  path?: { x: number; y: number }[]
  /** What was under the pointer, `pick` only — including its source location. */
  element?: BrowserElement
  /** Every visible element fully inside a `region` drag. One grouped mark keeps
   *  a marquee selection together instead of turning one gesture into a stack
   *  of unrelated comments. */
  elements?: BrowserElement[]
  /** The user's words about this mark. */
  note?: string
  createdAt: number
  /** The mark's stable ordinal, assigned in click order by the overlay and kept
   *  for the life of the mark — so mark "3" stays "3" after "2" is removed in
   *  the comment popup, attachment, and prompt. Optional so a mark from an older
   *  read still renders, falling back to its position in the list. */
  number?: number
}

/** Everything the user has marked on one page. Held in the guest and read back
 *  on demand, so a reload clears it exactly as the page's own state does. */
export interface BrowserAnnotationState {
  browserPageId: string
  annotations: BrowserAnnotation[]
}

/** Changes to an annotation set. One op union rather than a method each: they
 *  all mutate the same guest-held state through the same evaluation. */
export type BrowserAnnotateOp =
  | { kind: 'note'; annotationId: string; note: string }
  | { kind: 'remove'; annotationId: string }
  | { kind: 'clear' }
  /** Live box-selection feedback for a streamed surface. Browser updates are
   *  coalesced by the client; the final update commits the same rectangle, so
   *  it cannot overtake an older browser on a remote connection. */
  | {
      kind: 'browserRegion'
      rect: { x: number; y: number; width: number; height: number } | null
      commit?: boolean
    }
  /**
   * One finished gesture, in the page's own viewport coordinates.
   *
   * A desktop `<webview>` is drawn on directly — the overlay sees the pointer
   * and needs none of this. A streamed surface cannot: the canvas is a picture,
   * and the only thing the client can do with a drag is describe it. Forwarding
   * the moves one at a time would be one round trip per pointer frame, which
   * over a network is not a stroke, so the client tracks the gesture locally,
   * draws its own ink while the finger is down, and commits the whole thing
   * here on release. The mark lands in the guest either way, which is what keeps
   * it inside captures and inside the prompt.
   */
  | { kind: 'mark'; tool: 'draw'; path: { x: number; y: number }[] }
  | { kind: 'mark'; tool: 'region'; rect: { x: number; y: number; width: number; height: number } }

/** Why a page is not showing what it should, in terms the pane can render. */
export interface BrowserProblem {
  kind: 'target-unreachable' | 'load-failed' | 'no-surface' | 'surface-crashed'
  message: string
}

/**
 * Why a client gave a surface back.
 *
 * A closed pane and a dead guest both end with the page having no surface, but
 * they are not the same state to a user: one is waiting, the other needs a new
 * guest. The client is the only side that can tell them apart.
 */
export type BrowserDetachReason = 'released' | 'crashed'

/**
 * A running dev server the scanner found, offered as a target. Discovery only —
 * Solus does not own these processes (the boot layer waits for the terminal).
 */
export interface BrowserDiscoveredTarget {
  url: string
  port: number
  pid: number
  /** The listening process's working directory, as the OS reports it. */
  cwd: string
  /** Set when the cwd resolves inside a git worktree. */
  worktreePath?: string
  branch?: string
  /** The repository the worktree belongs to, for grouping in the picker. */
  projectRoot?: string
  /** From the probed HTML, when it had a title. */
  title?: string
}

/**
 * One element in a snapshot, normalized across web (DOM + accessibility) and
 * device (platform accessibility tree) targets so agent tools never fork.
 */
export interface BrowserElement {
  /** ARIA role, or the platform's nearest equivalent. */
  role: string
  /** Accessible name. */
  label: string
  /** CSS-pixel rect in the page's own viewport coordinates. */
  rect: { x: number; y: number; width: number; height: number }
  /** A selector the drive verbs accept. Web: a CSS selector. */
  ref: string
  /** Author-supplied identity (`data-testid`, `id`, iOS accessibility id). */
  identifier?: string
  /** Svelte dev-mode source, when the guest carries `__svelte_meta`. */
  source?: { file: string; line: number; column: number }
  disabled?: boolean
  value?: string
}

/**
 * What the page's own performance timeline says about how it loaded.
 *
 * The browser measures these whether or not anyone asks, so a snapshot reads
 * them rather than computing anything: the capture is already standing in front
 * of a real Chromium at a known viewport, and the marginal cost of collecting
 * them is one expression. Every member is optional because a metric that has not
 * happened yet — a page with no contentful paint, a load still in flight — must
 * read as absent rather than as zero.
 *
 * `cls` is unitless; every other member is milliseconds from the navigation
 * start.
 */
export interface BrowserWebVitals {
  /** Time to first byte: `responseStart` of the navigation entry. */
  ttfbMs?: number
  /** First Contentful Paint — the first text or image painted. */
  fcpMs?: number
  /** Largest Contentful Paint — when the main content became visible. */
  lcpMs?: number
  /** Cumulative Layout Shift — how much the page moved under the reader. */
  cls?: number
  domContentLoadedMs?: number
  loadMs?: number
}

export interface BrowserSnapshot {
  browserPageId: string
  url: string
  title: string
  viewport: BrowserViewport
  appearance: BrowserAppearance
  /** PNG data URL of the emulated viewport. Omitted when the caller asked for
   *  structure only — a full-page image is the expensive part of a snapshot. */
  screenshot?: string
  elements: BrowserElement[]
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
  /** Absent when the guest reported no timings — a page that never navigated,
   *  or one whose performance timeline the caller asked to skip. */
  vitals?: BrowserWebVitals
  capturedAt: number
}

/**
 * What the conversation shows after an agent looks at a page.
 *
 * A snapshot is the one agent verb whose whole point is visual, and tool output
 * never reaches a client — so the picture would otherwise exist only in the
 * agent's context. This is the bounded projection that crosses instead: the
 * asset id, and the facts a reader needs to judge whether the capture is the one
 * they care about. The image itself stays in the host asset store and is fetched
 * on demand, so the wire cost is a few hundred bytes however large the PNG is.
 */
export interface BrowserSnapshotRef {
  browserPageId: string
  /** Resolved by the client as `asset://<assetId>`. */
  assetId: string
  url: string
  title: string
  /** Formatted once, here, so the pane, the agent's transcript, and the card
   *  cannot describe the same capture three different ways. */
  viewport: string
  /**
   * Which colour scheme the page was rendered under.
   *
   * A frame carries no provenance of its own: a card read a day later has to say
   * what was on screen, and "the dark one looked wrong" is unanswerable when the
   * capture never said which one it was. The size alone cannot carry it.
   */
  appearance: BrowserAppearance
  elementCount: number
  /** Errors in the page's console at capture time. A screenshot that looks right
   *  while the console is on fire is exactly what a visual check should surface,
   *  and it is the one fact the picture cannot carry by itself. */
  consoleErrors: number
  capturedAt: number
}

/**
 * Where a capture is filed so it outlives the turn that took it.
 *
 * A screenshot in an agent's context is gone the moment the session ends. The
 * evidence loop's whole job is to put it somewhere durable and shared — the
 * task the work belongs to, or the pull request a human will read.
 *
 * A PR target carries the checkout it belongs to rather than an owner/repo pair:
 * the remote is a fact of the worktree, and asking a caller to restate it is how
 * a capture ends up on the wrong repository.
 */
export type BrowserEvidenceTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'pr'; number: number; cwd: string }

/** What a capture became. */
export interface BrowserEvidence {
  browserPageId: string
  /** The host-owned asset. Clients resolve it as `asset://<assetId>`. */
  assetId: string
  /** Absolute path on the host that owns the capture. A composer attachment
   *  carries this back to an agent running on that host; clients treat it as an
   *  opaque value and use `assetId` when they need a display URL. */
  hostPath: string
  /** Where it landed, in the words the pane and the agent both use. */
  attachedTo: string
  /**
   * Set only when the capture had to leave Solus to be readable — a PR body
   * cannot render a local asset, so those bytes are published to the repository
   * and the comment points at that URL instead.
   */
  publishedUrl?: string
  url: string
  viewport: string
  capturedAt: number
}

export interface BrowserCaptureRequest {
  browserPageId: string
  /** Omitted takes the capture and stores it without filing it anywhere. */
  attach?: BrowserEvidenceTarget
  caption?: string
}

/**
 * What this page's capture could be attached to, resolved by the host.
 *
 * Only the host can answer it: the pull request belongs to the branch the page's
 * worktree is on, which a client cannot see. Absent members mean "nothing to
 * attach to here", which the pane states rather than offering a dead action.
 */
export interface BrowserEvidenceOptions {
  worktreePath?: string
  branch?: string
  pullRequest?: { number: number; url: string }
}

/** How a capture reads in a card and in the agent's own transcript. */
export function snapshotViewportLabel(viewport: BrowserViewport): string {
  const label = viewportLabel(viewport)
  return `${label} — ${viewport.width}×${viewport.height}`
}

export interface BrowserSnapshotOptions {
  /** Default true. */
  screenshot?: boolean
  /** Cap on returned elements, so a large page cannot blow the agent's context. */
  maxElements?: number
  /** Default true. One expression against a timeline the browser already keeps. */
  vitals?: boolean
}

/** The typed high-level ops a surface understands. Raw CDP never crosses a
 *  boundary; this union is the whole vocabulary the bridge speaks. */
export type BrowserNavigateOp =
  | { kind: 'goto'; url: string }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'reload' }

export type BrowserInteractOp =
  | { kind: 'click'; ref: string }
  | { kind: 'type'; ref: string; text: string; clear?: boolean }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; ref?: string; deltaY: number }
  | { kind: 'evaluate'; expression: string }
  | { kind: 'waitFor'; expression: string; timeoutMs?: number }
  // Coordinate-addressed input. The agent verbs above name an element; a person
  // interacting with a streamed surface points at a pixel, so these carry the
  // CSS-viewport coordinate the client mapped its pointer to. `insertText` types
  // into whatever a preceding `clickAt` focused, so a streamed keyboard needs no
  // selector either.
  | { kind: 'clickAt'; x: number; y: number }
  | { kind: 'scrollAt'; x: number; y: number; deltaY: number }
  | { kind: 'insertText'; text: string }

export interface BrowserInteractResult {
  ok: boolean
  /** JSON-serialized result of `evaluate`/`waitFor`. */
  value?: string
  message?: string
}

export interface BrowserOpenRequest {
  target: BrowserTarget
  presetId?: string
  orientation?: BrowserOrientation
  appearance?: BrowserAppearance
  label?: string
  /**
   * Ask a connected desktop client to give the page a surface — how an agent
   * opening a page ends up with something that can actually render. Explicit
   * invocation, never a background auto-open.
   */
  requestSurface?: boolean
}

/**
 * What a native guest is mounted at, before it is told where to go.
 *
 * A `<webview>` given its real `src` starts fetching immediately — before the
 * host has attached CDP and applied emulation — so the page lays out at the
 * window's own size and then relayouts when the metrics override lands. A blank
 * document commits instantly and carries no traffic, so the guest is attached
 * and emulated *first* and the real navigation lays out once, at the size the
 * user actually chose. Both sides name it: the client mounts it, the host
 * refuses to publish it as a page's address.
 */
export const BROWSER_BLANK_URL = 'about:blank'

/** Every browser profile's partition name starts with this. The host that owns
 *  the profiles refuses to clear a session outside it. */
export const BROWSER_PARTITION_PREFIX = 'persist:solus-browser'

/**
 * A stable, filesystem-safe partition name for one project's browser profile.
 *
 * Profiles are per project, not per worktree: a login obtained in one branch's
 * checkout is the same login the next branch needs, and re-authenticating per
 * worktree would make multi-worktree QA unusable.
 *
 * It lives in the contract because both sides mint it — the renderer for the
 * `<webview>` it mounts, the server for the headless guest it opens — and a page
 * whose two hosts disagreed about the name would silently lose its login on
 * every migration.
 */
export function browserPartition(projectRoot: string | undefined): string {
  if (!projectRoot) return BROWSER_PARTITION_PREFIX
  let hash = 5381
  for (let i = 0; i < projectRoot.length; i += 1) {
    hash = ((hash << 5) + hash + projectRoot.charCodeAt(i)) | 0
  }
  return `${BROWSER_PARTITION_PREFIX}-${(hash >>> 0).toString(36)}`
}

/**
 * What a surface reports back after it moves.
 *
 * A client's `<webview>` reports what the user's guest is doing; a headless
 * guest reports its own, because nothing is watching it. One shape either way:
 * the registry publishes it identically, so a page hosted headless is as
 * legible as a page in a pane.
 */
export interface BrowserSurfaceReport {
  url: string
  title: string
  loadState: BrowserLoadState
  canGoBack: boolean
  canGoForward: boolean
  failure?: string
}

/**
 * A streamed frame's header.
 *
 * Frames travel on a binary side-channel, not through the typed-event envelope:
 * the JPEG bytes ride as their own wire frame, and this header — a plain object
 * — rides beside them so the client knows which page a frame belongs to. It is
 * deliberately tiny; everything else about the page (its viewport, its title)
 * the client already mirrors from `browser.pageChanged`.
 */
export interface BrowserFrameHeader {
  browserPageId: string
  /**
   * Monotonic per page. Decoding a JPEG is asynchronous, so two frames can be
   * in flight through `createImageBitmap` at once; the client paints a frame
   * only if its seq beats the last one it painted, which is latest-frame-wins.
   */
  seq: number
}

/**
 * Caps on a streamed frame, applied at the source.
 *
 * A phone pane has no use for a 2560×1440 desktop browser streamed at full
 * device-pixel resolution — it is wire budget spent on pixels no one can see.
 * The host caps the frame to CSS-viewport size bounded by this dimension, and
 * encodes JPEG rather than PNG because a browser is a moving picture, not an
 * asset to pixel-diff.
 */
export const BROWSER_FRAME_MAX_DIMENSION = 1600
export const BROWSER_FRAME_QUALITY = 60
