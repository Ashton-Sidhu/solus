/**
 * Layout discipline — a surface learns its width from the container it renders
 * in, never from the OS window.
 *
 * `WorkspaceBody` splits the window into a sidebar pane, a primary pane, and a
 * companion pane, each independently resizable. The primary pane's floor is 25%
 * of the split, so it is legally ~356px on a 1440px window. Every window-width
 * reading inside a pane is wrong by that much, and every leaf that shrinks past
 * its rigid children paints over its neighbour. Full audit:
 * `docs/plans/responsive-surfaces.md`.
 *
 * This is a text checker rather than an oxlint rule because two of its three
 * rules live in markup and CSS, which oxlint does not parse — it reads only the
 * `<script>` block of a `.svelte` file.
 *
 * Run with `bun run lint:layout`.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const COMPONENTS_ROOT = 'packages/workspace-ui/src/components'

/**
 * Surfaces that are portalled and positioned against the window, so the window
 * genuinely is their container. A tooltip, menu, toast, palette, or orb popover
 * escapes the pane tree entirely; asking it to measure a pane would be the bug.
 */
const VIEWPORT_ANCHORED = [
  'command-palette/',
  'comments/CommentLayer.svelte',
  'input/UnifiedAutocompleteMenu.svelte',
  'layout/ActionOrb.css',
  'layout/ActionOrb.svelte',
  'ui/Dropdown.svelte',
  'ui/dropdown-menu/',
  'ui/tooltip/',
  'ui/toast/',
  'popoverLayer.svelte.ts',
  'portal.ts',
  // The pill shell sizes the OS window itself, which is the one place the window
  // is the right question (locked decision 3).
  'layout/PillLayout.svelte',
  // TabStrip is imported only by PillLayout, where the pill window *is* the
  // container. It becomes an offender the moment the strip is reused elsewhere.
  'layout/TabStrip.css',
  'layout/TabStrip.svelte',
  // The geometry helper for a `use:portal` + `position: fixed` bubble. The
  // structural check cannot see that from here: the overlay is one file away,
  // and this module is only the arithmetic that clamps it to the window it is
  // pinned to.
  'document-shell/lib/selection-bubble.ts',
  // A full-bleed modal shell: `100dvw` here means "cover the window", which is
  // what the surface is for. Its narrow rungs already use `@container doc-shell`.
  'plan/PlanModal.css',
]

type Rule = 'spill' | 'viewport-unit' | 'window-read' | 'laptop-outranks-touch'

type Failure = {
  path: string
  line: number
  rule: Rule
  detail: string
}

/**
 * A surface that portals out of the pane tree, or pins itself to the window
 * with `position: fixed`, has escaped its container by construction. Detecting
 * that structurally beats an ever-growing filename allowlist: it is the same
 * fact the surface already had to declare to render correctly.
 */
const ESCAPES_PANE_TREE = /use:portal[={]|getPopoverLayer|position:\s*fixed|(?<![\w-])fixed(?![\w-])\s+inset-0/u

function isViewportAnchored(path: string, source: string): boolean {
  return VIEWPORT_ANCHORED.some((entry) => path.includes(entry)) || ESCAPES_PANE_TREE.test(source)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(svelte|css|ts)$/u.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/**
 * Blank out comment bodies, preserving length so every reported line number
 * still points at the real line.
 *
 * A rule you cannot name in a comment is a rule people route around. The fix
 * for a window read is usually a comment explaining which axis replaced it, and
 * that comment has to be free to say `isMobileViewport` out loud.
 */
function withoutComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|(^|[^:"'`\\])\/\/[^\n]*/gu, (match, lead: string | undefined) => {
    const body = match.slice(lead?.length ?? 0)
    // Newlines survive: they are what every reported line number is counted
    // from. Blanking them shifts every finding below a block comment.
    return (lead ?? '') + body.replace(/[^\n]/gu, ' ')
  })
}

function lineOf(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

// ---------------------------------------------------------------------------
// Markup scanning
//
// A `>` can appear inside an attribute string or inside a Svelte expression
// (`class={a > b ? …}`), so the tag boundary cannot be found with a regex. This
// walks characters, tracking quote and brace depth, which is enough structure
// for the one question we ask of a tag: what is in its attribute text.
// ---------------------------------------------------------------------------

type Tag = {
  name: string
  attributes: string
  start: number
  closing: boolean
  selfClosing: boolean
}

function scanTags(source: string): Tag[] {
  const tags: Tag[] = []
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '<') continue
    const nameMatch = /^<(\/?)([a-zA-Z][\w.:-]*)/u.exec(source.slice(i, i + 64))
    if (!nameMatch) continue

    let cursor = i + nameMatch[0].length
    let quote = ''
    let braces = 0
    for (; cursor < source.length; cursor++) {
      const char = source[cursor]
      if (quote) {
        if (char === quote) quote = ''
        continue
      }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue }
      if (char === '{') { braces++; continue }
      if (char === '}') { braces--; continue }
      if (char === '>' && braces === 0) break
    }
    if (cursor >= source.length) break

    const attributes = source.slice(i + nameMatch[0].length, cursor)
    tags.push({
      name: nameMatch[2],
      attributes,
      start: i,
      closing: nameMatch[1] === '/',
      selfClosing: attributes.trimEnd().endsWith('/'),
    })
    i = cursor
  }
  return tags
}

/** Word-boundary aware, so `min-w-0.5` is not `min-w-0` and `md:min-w-0` is. */
function hasClass(text: string, name: string): boolean {
  return new RegExp(String.raw`(?<![\w-])${name}(?![\w.-])`, 'u').test(text)
}

const RIGID = /(?<![\w-])(?:flex-)?shrink-0(?![\w.-])/u

/**
 * Spill — an interactive leaf that lies about its box.
 *
 * `min-width: 0` lets a flex item shrink past its content, but rigid children
 * keep their size and paint outside the border box, over the neighbour. On a
 * flex *container* `min-w-0` is correct and necessary; it delegates truncation
 * to a descendant. Only a leaf with rigid children and no clip is a defect.
 */
export function findSpills(source: string, path: string): Failure[] {
  const failures: Failure[] = []
  const tags = scanTags(source)

  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index]
    if (tag.closing || tag.selfClosing) continue
    if (tag.name !== 'button' && tag.name !== 'a') continue
    if (!hasClass(tag.attributes, 'min-w-0')) continue
    if (hasClass(tag.attributes, 'overflow-hidden') || hasClass(tag.attributes, 'overflow-clip')) continue

    let depth = 1
    let rigidChildren = 0
    for (let inner = index + 1; inner < tags.length && depth > 0; inner++) {
      const child = tags[inner]
      if (child.name === tag.name) depth += child.closing ? -1 : (child.selfClosing ? 0 : 1)
      if (depth === 0) break
      if (!child.closing && RIGID.test(child.attributes)) rigidChildren++
    }
    if (rigidChildren === 0) continue

    failures.push({
      path,
      line: lineOf(source, tag.start),
      rule: 'spill',
      detail: `<${tag.name}> has min-w-0, no overflow clip, and ${rigidChildren} rigid ${rigidChildren === 1 ? 'child' : 'children'}`,
    })
  }
  return failures
}

// ---------------------------------------------------------------------------
// Viewport units
// ---------------------------------------------------------------------------

/**
 * `min(28rem, calc(100vw - 2rem))` is the sanctioned cap: it says "never wider
 * than the window", which is true in any container. Only a viewport unit used
 * as the *measure* is a defect.
 */
function isViewportCap(source: string, index: number): boolean {
  let depth = 0
  for (let i = index; i >= 0; i--) {
    const char = source[i]
    if (char === ')') depth++
    else if (char === '(') {
      if (depth > 0) { depth--; continue }
      const name = /([a-zA-Z-]+)$/u.exec(source.slice(Math.max(0, i - 16), i))
      if (name && (name[1] === 'min' || name[1] === 'max')) return true
    } else if (char === '\n' && depth === 0) return false
  }
  return false
}

function findViewportUnits(source: string, path: string): Failure[] {
  if (isViewportAnchored(path, source)) return []
  const failures: Failure[] = []
  // Inline axis only. The three named containers are declared `inline-size`, so
  // a block-axis container query does not exist to migrate `vh` to — flagging it
  // would be reporting a defect with no sanctioned fix. Width is the thesis.
  const pattern = /(?<![\w.-])(\d+(?:\.\d+)?)(vw|dvw|svw|lvw|vi)(?![\w-])/gu
  for (const match of source.matchAll(pattern)) {
    if (isViewportCap(source, match.index)) continue
    failures.push({
      path,
      line: lineOf(source, match.index),
      rule: 'viewport-unit',
      detail: `${match[1]}${match[2]} measures the OS window, not the container`,
    })
  }
  return failures
}

// ---------------------------------------------------------------------------
// A laptop variant outranking the touch rung beside it
//
// `.is-laptop-display` is set from `screen.width <= 1600`, so every phone and
// tablet carries it — on web and mobile as much as on a small MacBook. A bare
// `[.is-laptop-display_&]:h-6` is a descendant combinator, two selectors; the
// `pointer-coarse:h-10` next to it is one class inside a media query, and a
// media query adds no specificity. The laptop value therefore wins on a phone
// and the touch rung never applies, whichever is written last: `h-10` was a
// 40px target and the hand got 24px.
//
// The fix is to fence the laptop value behind `pointer-fine:`, which is what
// `menu/menu-row.ts` already does. This is the same trap the publish menu hit
// on the type axis, where the laptop rung outranked a call site's `h-auto` and
// clamped a two-line row.
//
// Only a property with a coarse rung beside it is a defect. A laptop value with
// no touch counterpart is the author saying the small-display geometry is right
// for a phone too, and that is a product choice rather than a cascade accident.
// ---------------------------------------------------------------------------

/** Longest first, so `min-h` is never matched as `h` with a `min-` prefix. */
const RUNG_PROPERTIES = [
  'min-h', 'max-h', 'min-w', 'max-w',
  'px', 'py', 'pt', 'pb', 'pl', 'pr',
  'gap', 'size', 'rounded', 'text', 'h', 'w', 'p',
]

/**
 * One element's whole class list, however it is spelled. A tag's attributes can
 * span lines and a shared list in a `lib/*-styles.ts` is a concatenation across
 * several, so a line is the wrong unit — `rail-styles.ts` carries its laptop
 * height and its touch height six lines apart on the same control.
 */
function classListUnits(source: string, path: string): { text: string; index: number }[] {
  if (path.endsWith('.svelte')) {
    return scanTags(source)
      .filter((tag) => !tag.closing)
      .map((tag) => ({ text: tag.attributes, index: tag.start }))
  }
  const units: { text: string; index: number }[] = []
  let index = 0
  // Split rather than match: "up to the next declaration or the end of the
  // file" has no portable regex spelling — JavaScript has no `\Z`, and `$`
  // under `m` stops at the first line break.
  for (const chunk of source.split(/(?=^export const )/mu)) {
    units.push({ text: chunk, index })
    index += chunk.length
  }
  return units
}

export function findLaptopOverTouch(source: string, path: string): Failure[] {
  const failures: Failure[] = []
  for (const unit of classListUnits(source, path)) {
    for (const property of RUNG_PROPERTIES) {
      // `\x60` is the backtick: String.raw keeps the backslash of an escaped
      // one, and a stray `\`` is an invalid escape under the `u` flag.
      const bare = new RegExp(String.raw`(?:^|[\s"'\x60{])\[\.is-laptop-display_&\]:${property}-`, 'u')
      const coarse = new RegExp(String.raw`(?:pointer-coarse|\[@media\(pointer:coarse\)\]):${property}-`, 'u')
      if (!bare.test(unit.text) || !coarse.test(unit.text)) continue
      failures.push({
        path,
        line: lineOf(source, unit.index),
        rule: 'laptop-outranks-touch',
        detail:
          `[.is-laptop-display_&]:${property}-… outranks the pointer-coarse:${property}-… beside it, ` +
          'so the touch rung never applies on a phone — fence it with pointer-fine:',
      })
      break
    }
  }
  return failures
}

// ---------------------------------------------------------------------------
// Window reads
// ---------------------------------------------------------------------------

const WINDOW_READS = [
  /(?<![\w.])window\.innerWidth(?![\w])/gu,
  /(?<![\w])isMobileViewport(?![\w])/gu,
  /(?<![\w])isCompactViewport(?![\w])/gu,
  /(?<![\w])workAreaWidth(?![\w])/gu,
]

function findWindowReads(source: string, path: string): Failure[] {
  if (isViewportAnchored(path, source)) return []
  const failures: Failure[] = []
  for (const pattern of WINDOW_READS) {
    for (const match of source.matchAll(pattern)) {
      failures.push({
        path,
        line: lineOf(source, match.index),
        rule: 'window-read',
        detail: `${match[0]} measures the OS window, not the container`,
      })
    }
  }
  return failures
}

// ---------------------------------------------------------------------------
// Baseline
//
// The rule is true today and the codebase is not, so a bare exit(1) would only
// mean the checker gets removed from `lint`. The baseline records what is
// already wrong per file per rule; the checker fails on anything above it and
// on any entry that outlived its defect. WP4 shrinks the baseline until it is
// empty, and the file itself is the WP4 work queue.
//
// Keyed by file and rule rather than by line, so an unrelated edit above a
// defect does not re-open it.
// ---------------------------------------------------------------------------

const BASELINE_PATH = 'scripts/layout-discipline-baseline.json'

type Baseline = { [key: string]: number }

function keyOf(failure: Failure): string {
  return `${failure.rule} ${failure.path}`
}

export function collect(root: string): Failure[] {
  const failures: Failure[] = []
  for (const file of walk(join(root, COMPONENTS_ROOT))) {
    const path = relative(root, file).split(sep).join('/')
    const source = readFileSync(file, 'utf8')
    // Spill reads the markup, so it needs the comments in place to find tag
    // boundaries. The other two read identifiers, where a comment is prose.
    if (file.endsWith('.svelte')) failures.push(...findSpills(source, path))
    const code = withoutComments(source)
    failures.push(
      ...findViewportUnits(code, path),
      ...findWindowReads(code, path),
      ...findLaptopOverTouch(code, path),
    )
  }
  return failures.sort((a, b) =>
    a.rule.localeCompare(b.rule) || a.path.localeCompare(b.path) || a.line - b.line)
}

export function readBaseline(root: string): Baseline {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8'))
    // Safety: the file is authored by `--update` below, so its shape is ours.
    return parsed as Baseline
  } catch {
    return {}
  }
}

export function countByKey(failures: Failure[]): Baseline {
  const counts: Baseline = {}
  for (const failure of failures) counts[keyOf(failure)] = (counts[keyOf(failure)] ?? 0) + 1
  return counts
}

/** Above baseline, plus baseline entries whose defect is gone. */
export function regressions(counts: Baseline, baseline: Baseline): string[] {
  const keys = new Set([...Object.keys(counts), ...Object.keys(baseline)])
  return [...keys].filter((key) => (counts[key] ?? 0) !== (baseline[key] ?? 0)).sort()
}

if (import.meta.main) {
  const root = process.cwd()
  const failures = collect(root)
  const counts = countByKey(failures)

  if (process.argv.includes('--update')) {
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(counts, null, 2)}\n`)
    console.log(`layout discipline: baseline written, ${failures.length} known failures`)
    process.exit(0)
  }

  if (process.argv.includes('--list')) {
    let previousRule: Rule | null = null
    for (const failure of failures) {
      if (failure.rule !== previousRule) {
        console.log(`\n${failure.rule}`)
        previousRule = failure.rule
      }
      console.log(`  ${failure.path}:${failure.line} — ${failure.detail}`)
    }
    console.log(`\n${failures.length} failures.`)
    process.exit(0)
  }

  const changed = regressions(counts, readBaseline(root))
  if (changed.length === 0) {
    console.log(`layout discipline: clean (${failures.length} known failures at baseline)`)
    process.exit(0)
  }

  for (const key of changed) {
    const [rule, path] = key.split(' ')
    const now = counts[key] ?? 0
    const was = readBaseline(root)[key] ?? 0
    console.log(now > was
      ? `${path}: ${now - was} new ${rule} failure(s)`
      : `${path}: ${was - now} ${rule} failure(s) fixed — run \`bun run lint:layout --update\``)
    for (const failure of failures.filter((f) => keyOf(f) === key)) {
      console.log(`  ${failure.path}:${failure.line} — ${failure.detail}`)
    }
  }
  console.log('\nWidth is declared by containers: docs/plans/responsive-surfaces.md')
  process.exit(1)
}
