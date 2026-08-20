import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { DIFFS_THEME_CSS } from '@solus/workspace-ui/lib/diffTheme'

/**
 * ADR-0013 — type is declared on a *surface* and inherited, from one of two
 * role ladders. The rules split in two, and the split matters:
 *
 *  - **Defects** (`defects`) — a value that is not on the scale at all, so the
 *    element renders at a size the design does not contain. Enforced against
 *    every file, always. Never ratcheted.
 *  - **Redundancy** (`redundancy`) — every value is on the scale, but the file
 *    restates it on its leaves instead of declaring a surface once. Invisible to
 *    a user, so this is what the pending list holds while the migration runs.
 *
 * Collapsing the two is how nine 13px buttons survived the migration that
 * retired 13px: `PrsPage.svelte` was pending for redundancy, and a single
 * exemption waved the defect through with it.
 */

const roots = [
  join(import.meta.dir, '../../src/renderer'),
  join(import.meta.dir, '../../apps/client/src'),
]

/**
 * Every size a file can spend, both ladders (ADR-0013).
 *
 * Chrome is **stock Tailwind** — `text-xs` 12 (meta), `text-sm` 14 (labels),
 * `text-base` 16 (section titles), `text-2xl` 24 (page titles). The jump from 16
 * to 24 is deliberate: nothing in chrome needs 18 or 20, and leaving those out
 * keeps the set small enough to hold in your head.
 *
 * Content rungs are custom because they carry the user's text preference, which
 * no stock class can. `menu` is a chrome token kept only while its value is
 * undecided; `menu-meta` (11px) is gone — it existed to optically match mono
 * keycaps, and chrome no longer sets type in mono.
 */
const RUNGS = [
  'text-xs',
  'text-sm',
  'text-base',
  'text-2xl',
  'text-menu',
  'text-workspace-chrome',
  'text-insights-chrome',
  'text-insights-summary',
  'text-insights-summary-heading',
  'text-transcript-card',
  'text-transcript-meta',
  'text-footnote',
  'text-caption',
  'text-body',
  'text-h1',
  'text-h2',
  'text-h3',
]

/**
 * A surface declaration plus a small number of genuine exceptions — a badge, a
 * timestamp, a heading. Past this, a file is restating type on its leaves
 * instead of declaring itself once.
 */
const MAX_SIZE_CLASSES_PER_FILE = 4

/** Pierre's gutter labels scale with the configurable code font, not the UI
 *  ladder, so they stay relative. */
const allowedRelativeFontSizes = new Set(['0.75', '0.85', '0.95'])

/** index.css owns every numeric size; diffTheme owns the code surfaces. */
const SIZE_DEFINING_FILES = new Set([
  'index.css',
  'lib/diffTheme.ts',
  // Enumerates every rung name as data for tailwind-merge; it renders nothing.
  'lib/tw.ts',
])

/**
 * Files still carrying leaf sizes, pending WP4 of `docs/plans/type-scale.md`.
 *
 * A ratchet, not an allowlist, and it covers **redundancy only**. A file here
 * may still restate a rung on its leaves; it may never carry a size that is off
 * the scale — `defects()` runs against every file regardless. The list may only
 * shrink: `the ratchet only tightens` fails if a file inside it has been
 * migrated and not removed, so a cleaned surface cannot drift back. Delete
 * entries as their surface lands; do not add.
 */
const pending: string[] = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/type-scale-pending.json'), 'utf8'),
)
const PENDING = new Set(pending)
const repoPath = (path: string) =>
  `${path.includes('/apps/client/src/') ? 'apps/client/src' : 'packages/workspace-ui/src'}/${sourcePath(path)}`

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (/\.(css|svelte|ts)$/.test(entry)) yield path
  }
}

function sourcePath(path: string): string {
  const root = roots.find((candidate) => path.startsWith(candidate)) ?? roots[0]
  return relative(root, path)
}

function location(path: string, source: string, offset: number): string {
  return `${sourcePath(path)}:${source.slice(0, offset).split('\n').length}`
}

function* allSources(): Generator<{ path: string; source: string }> {
  for (const root of roots) {
    for (const path of sourceFiles(root)) {
      yield { path, source: readFileSync(path, 'utf8') }
    }
  }
}

describe('renderer type scale', () => {
  test('keeps Pierre gutter labels relative to the code font size', () => {
    // WHY: Fixed rem sizes make hunk labels larger than the surrounding gutter text.
    expect(DIFFS_THEME_CSS).toContain('font-size: 0.75em;')
    expect(DIFFS_THEME_CSS).toContain('font-size: 0.85em;')
    expect(DIFFS_THEME_CSS).toContain('font-size: 0.95em;')
  })

  /**
   * A value that is not on the scale at all. These are *defects* — the element
   * renders at a size the design does not contain — so the ratchet never
   * exempts them. `PrsPage.svelte` sat on the retired 13px rung for a whole
   * migration because it was pending for a repetition rule and the ratchet
   * waved every rule through at once.
   */
  function defects(path: string, source: string): string[] {
    if (SIZE_DEFINING_FILES.has(sourcePath(path))) return []
    const found: string[] = []

    // Chrome spends xs / sm / base / 2xl. `lg`, `xl` and `3xl`+ are outside the
    // set: a size in those gaps is either a content rung wearing a chrome name
    // or a one-off nobody chose deliberately.
    for (const match of source.matchAll(/\btext-(lg|xl|[3-9]xl)\b/g)) {
      found.push(`${location(path, source, match.index)} ${match[0]}`)
    }
    for (const match of source.matchAll(/text-\[[^\]]*(?:rem|px)\]/g)) {
      found.push(`${location(path, source, match.index)} ${match[0]}`)
    }

    // A numeric size outside index.css is a rung nobody can find or change.
    for (const match of source.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)(rem|px|em)/g)) {
      // `1em` is "match my parent" — an inheritance statement, not a size.
      if (match[2] === 'em' && match[1] === '1') continue
      if (match[2] === 'em' && allowedRelativeFontSizes.has(match[1])) continue
      found.push(`${location(path, source, match.index)} ${match[0]}`)
    }

    return found
  }

  /**
   * Redundancy: every value is on the scale, but the file restates it instead of
   * declaring a surface. Real, but not visible to a user — so this is what the
   * ratchet holds while the migration finishes.
   */
  function redundancy(path: string, source: string): string[] {
    if (SIZE_DEFINING_FILES.has(sourcePath(path))) return []
    const found: string[] = []

    // Repetition is the whole signal, and it is the rule the old standard was
    // missing: `SettingsPopover.svelte` spent ONE size, `text-xs`, and wrote it
    // 31 times. Counting *distinct* sizes calls that file clean, which is why
    // this counts occurrences instead.
    //
    // There is deliberately no rule about how many distinct rungs a file may
    // use. A page legitimately spends a title, a label and a meta line —
    // `GitHubConnect.svelte` is three rungs in three classes, with nothing
    // restated. Where variety really is excessive it is already caught here,
    // since five rungs cannot fit in four classes.
    const counts = RUNGS.map((rung) => ({
      rung,
      hits: [...source.matchAll(new RegExp(`(?:^|[\\s"'\`:])${rung}(?![\\w-])`, 'g'))].length,
    })).filter(({ hits }) => hits > 0)

    const total = counts.reduce((sum, { hits }) => sum + hits, 0)
    if (total > MAX_SIZE_CLASSES_PER_FILE) {
      found.push(
        `${sourcePath(path)} spends ${total} size classes (max ${MAX_SIZE_CLASSES_PER_FILE}) — ` +
          `declare the surface once and let its children inherit`,
      )
    }

    return found
  }

  test('nothing anywhere renders at a size off the scale', () => {
    // WHY: not ratcheted. A file may still be redundant, but no file may carry
    // a value the design does not contain — that is a rendering defect, and
    // exempting it because the file is pending for a *different* rule is how
    // PrsPage kept nine 13px buttons through the migration that retired 13px.
    const offenders: string[] = []
    for (const { path, source } of allSources()) offenders.push(...defects(path, source))
    expect(offenders).toEqual([])
  })

  test('no new redundancy outside the pending migration', () => {
    const offenders: string[] = []
    for (const { path, source } of allSources()) {
      if (PENDING.has(repoPath(path))) continue
      offenders.push(...redundancy(path, source))
    }
    expect(offenders).toEqual([])
  })

  test('the ratchet only tightens — a migrated file leaves the pending list', () => {
    const migrated: string[] = []
    for (const { path, source } of allSources()) {
      if (!PENDING.has(repoPath(path))) continue
      if (redundancy(path, source).length === 0) migrated.push(repoPath(path))
    }
    // WHY: leaving a clean file in the list lets it silently regrow leaf sizes
    // later, which is exactly how the previous standard rotted.
    expect(migrated).toEqual([])
  })

  test('the pending list names files that exist', () => {
    const known = new Set([...allSources()].map(({ path }) => repoPath(path)))
    expect(pending.filter((entry) => !known.has(entry))).toEqual([])
  })

  /**
   * Persistent workspace chrome — the rails, list pages, rows and headers that
   * stay on screen. Dialogs and forms (`servers/`, `settings/`, `connections/`)
   * are deliberately outside: they are transient, and a fixed size there is a
   * choice rather than an oversight.
   */
  const CHROME_DIRS = [
    'components/ui/list-page/',
    'components/session/',
    'components/project-panel/',
    'components/layout/',
    'components/workspace/',
    'components/prs/',
    'components/tasks/',
    'components/automations/',
    'components/pickers/',
    'components/command-palette/',
  ]
  const CHROME_FILES = ['components/conversation/SessionBreadcrumb.svelte']
  const isChrome = (path: string) => {
    const rel = sourcePath(path)
    return CHROME_DIRS.some((dir) => rel.startsWith(dir)) || CHROME_FILES.includes(rel)
  }

  const chromePending: string[] = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/chrome-fixed-size-pending.json'), 'utf8'),
  )
  const CHROME_PENDING = new Set(chromePending)

  const rungOverridePending: string[] = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/rung-override-pending.json'), 'utf8'),
  )
  const RUNG_OVERRIDE_PENDING = new Set(rungOverridePending)

  /** A call site redefining what a rung *means*, rather than picking one. */
  const rungOverrides = (source: string) => [...source.matchAll(/\[--text-[a-z-]+:/g)]

  /**
   * A fixed 14px on a surface that is supposed to follow the display.
   *
   * Unprefixed only. `max-md:text-sm` is a different statement: it bumps type
   * up on a phone, where 14px is the readable floor, and several composers and
   * dialogs rely on it. Catching those too would have meant either deleting a
   * deliberate mobile size or parking the file on the ratchet forever.
   */
  const fixedChromeSize = (source: string) =>
    [...source.matchAll(/(?<![\w:-])text-sm(?![\w-])/g)]

  test('a rung is picked by name, never redefined at a call site', () => {
    // WHY: `--text-workspace-chrome` is a contract — 14px, stepping to 12px on a
    // laptop display. A surface that overwrites its value inline is not picking
    // a rung, it is minting a private one, and it has to restate the laptop and
    // coarse-pointer boundary by hand to do so. Six copies of that boundary had
    // already accumulated, each able to drift on its own. Rungs are defined in
    // index.css; `--text-chrome-dense` exists so a dense surface has one to pick.
    const offenders: string[] = []
    for (const { path, source } of allSources()) {
      if (SIZE_DEFINING_FILES.has(sourcePath(path))) continue
      if (RUNG_OVERRIDE_PENDING.has(repoPath(path))) continue
      for (const match of rungOverrides(source)) {
        offenders.push(`${location(path, source, match.index)} ${match[0]}…]`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('persistent chrome never pins a fixed 14px', () => {
    // WHY: this is the rule that acts on code nobody has written yet. In chrome,
    // text is either primary — so it rides a rung and follows the display — or
    // it is supporting metadata, which is `text-xs` and fixed deliberately.
    // There is no third case, so `text-sm` on a rail or a list row is always a
    // surface someone forgot. Fifteen sessions of hand-resizing text were spent
    // finding these by eye on a large display; this finds them in CI instead.
    const offenders: string[] = []
    for (const { path, source } of allSources()) {
      if (!isChrome(path) || CHROME_PENDING.has(repoPath(path))) continue
      for (const match of fixedChromeSize(source)) {
        offenders.push(`${location(path, source, match.index)} text-sm`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('both new ratchets only tighten, and name files that exist', () => {
    const known = new Set([...allSources()].map(({ path }) => repoPath(path)))
    const stale = [...chromePending, ...rungOverridePending].filter((e) => !known.has(e))
    expect(stale).toEqual([])

    const migrated: string[] = []
    for (const { path, source } of allSources()) {
      const repo = repoPath(path)
      if (CHROME_PENDING.has(repo) && fixedChromeSize(source).length === 0) migrated.push(repo)
      if (RUNG_OVERRIDE_PENDING.has(repo) && rungOverrides(source).length === 0) migrated.push(repo)
    }
    // WHY: a cleaned surface that stays on the list can silently regrow.
    expect(migrated).toEqual([])
  })
})
