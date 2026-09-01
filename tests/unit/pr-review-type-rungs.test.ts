import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * The pull request review is the one surface in the workspace that puts a
 * reading column and a dense reference rail side by side, so it declares its
 * own three-step ladder rather than borrowing the app's chrome rung:
 *
 *   text-review-row    12.5px  rail rows, meta-band values
 *   text-review-meta     11px  sub-lines, counts, verdicts, durations, paths
 *   text-micro           10px  uppercase letterspaced captions
 *
 * The caption step is the app-wide bottom rung, not a review-owned one: the
 * keybindings surfaces needed the same size and briefly declared a second rung
 * half a pixel away from it. Only the top two steps belong to this surface.
 *
 * On `text-workspace-chrome` (14px on a desktop display) the rail shouted over
 * the prose it annotates and the labelled band under the title read as a second
 * heading. Each rung steps down on a precise-pointer laptop; touch keeps the
 * desktop size (ADR-0010/0013).
 *
 * These are asserted against the markup because there is nothing else to assert
 * them against: the rule lives entirely in the class lists. What is being
 * pinned is the *ladder* — that caption, meta and row are three distinct rungs
 * and none of them is a fixed size the display cannot step. That is the shape
 * the defect had, twice: first `text-xs` captions, then a whole surface left on
 * the chrome rung.
 */
const UI_ROOT = join(import.meta.dir, '../../packages/workspace-ui/src')
const REVIEW_DIR = join(UI_ROOT, 'components/pr-review')

const REVIEW_RUNGS = ['text-review-row', 'text-review-meta', 'text-micro']

function source(file: string): string {
  return readFileSync(join(REVIEW_DIR, file), 'utf8')
}

/** Every class list in the file that styles a letterspaced uppercase caption. */
function captionClassLists(file: string): string[] {
  return source(file)
    .split(/\n/)
    .filter(
      (line) => line.includes('tracking-[0.12em]') && line.includes('uppercase'),
    )
}

describe('the review rungs', () => {
  test('are declared with a laptop step, and registered with tailwind-merge', () => {
    // WHY: a custom @theme font-size key that tailwind-merge does not know is
    // read as a colour and silently dropped against the `text-muted-foreground`
    // sitting beside it on almost every one of these elements — the class
    // compiles, reaches nothing, and the surface keeps its inherited size.
    const css = readFileSync(join(UI_ROOT, 'index.css'), 'utf8')
    const twConfig = readFileSync(join(UI_ROOT, 'lib/tw.ts'), 'utf8')
    const laptopBlock = css.slice(css.indexOf('html.is-laptop-display'))
    for (const rung of REVIEW_RUNGS) {
      const custom = `--${rung.replace('text-', 'text-')}`
      expect(css).toContain(`${custom}:`)
      expect(laptopBlock).toContain(`${custom}:`)
      expect(twConfig).toContain(`'${rung}'`)
    }
  })
})

describe('the pull request review captions', () => {
  test('the meta band and the rail actually have captions to check', () => {
    // Guards the tests below from passing vacuously if the caption markup is
    // ever restructured out from under the filter. One each: the band's shared
    // caption snippet, and the rail's section heading. The rail had a second —
    // the merge card's eyebrow — until it turned out to restate its own
    // headline.
    expect(captionClassLists('PrMetaBand.svelte')).toHaveLength(1)
    expect(captionClassLists('PrActivityRail.svelte')).toHaveLength(1)
  })

  test('take the label rung, a step under the values they name', () => {
    for (const file of ['PrMetaBand.svelte', 'PrActivityRail.svelte']) {
      for (const classes of captionClassLists(file)) {
        expect(classes).toContain('text-micro')
      }
    }
  })

  test('never take a fixed rung the display cannot step', () => {
    // `text-xs` is the specific regression: 12px at every width, which is the
    // rail's own row size on a laptop.
    for (const file of ['PrMetaBand.svelte', 'PrActivityRail.svelte']) {
      for (const classes of captionClassLists(file)) {
        expect(classes.split(/\s+/)).not.toContain('text-xs')
      }
    }
  })
})

describe('the rail and the meta band', () => {
  test('use the same two rungs and no third size between them', () => {
    // WHY: the rail and the band describe the same kinds of fact — a labelled
    // caption over a value — a screen apart on one page. While the rail had a
    // third rung in the middle, a check verdict, a file name and a section
    // count each sat at a size the band never uses, so the two halves of the
    // surface disagreed about how big a "value" is. Two rungs, everywhere.
    const band = source('PrMetaBand.svelte')
    const rail = source('PrActivityRail.svelte')
    for (const markup of [band, rail]) {
      expect(markup).toContain('text-micro')
      expect(markup).not.toContain('text-review-meta')
    }
  })
})

describe('the review surfaces', () => {
  test('declare the review row rung rather than the app chrome rung', () => {
    // WHY: `text-workspace-chrome` is 14px on a desktop display. Every row in
    // the band and the rail inherits from these two containers, so leaving
    // either on the chrome rung puts the whole surface a step over the spec —
    // which is exactly what shipped.
    const band = source('PrMetaBand.svelte')
    const rail = source('PrActivityRail.svelte')
    for (const markup of [band, rail]) {
      expect(markup).toContain('text-review-row')
      expect(markup).not.toContain('text-workspace-chrome')
    }
  })
})

describe('the rail section headings', () => {
  test('carry no fill at rest', () => {
    // WHY: the sections default to open, so `aria-expanded` is *true* at rest.
    // The ghost button variant reads that attribute as a menu trigger and
    // paints `aria-expanded:bg-muted`, which put a permanent pressed chip
    // behind REVIEWERS / CHECKS / CHANGED FILES. A heading is a semantic-only
    // control: hover wash only. Asserting the primitive is not reachable here
    // is what keeps the whole family of `aria-expanded:` and `dark:hover:`
    // twins out, rather than patching one modifier at a time.
    const rail = source('PrActivityRail.svelte')
    const head = rail.slice(
      rail.indexOf('{#snippet sectionHead('),
      rail.indexOf('{/snippet}', rail.indexOf('{#snippet sectionHead(')),
    )
    expect(head).toContain('aria-expanded={sectionOpen[key]}')
    expect(head).toContain('<button')
    expect(head).not.toContain('variant="ghost"')
    expect(head).toContain('hover:bg-[var(--wash-2)]')
    // Keyboard reach survives the drop to a raw element.
    expect(head).toContain('focus-visible:')
  })
})

describe("the merge card's headline", () => {
  test('steps down on a laptop display like the rows beneath it', () => {
    // WHY: pinned at `text-base` the card's one sentence stayed 16px while the
    // rail around it shrank, so it grew a step louder exactly where the column
    // is narrowest.
    const headline = source('PrActivityRail.svelte')
      .split(/\n/)
      .find((line) => line.includes('tracking-[-0.014em]'))
    expect(headline).toBeDefined()
    expect(headline).toContain('text-[14.5px]')
    expect(headline).toContain('[.is-laptop-display_&]:text-[13px]')
  })
})

describe('the pull request title', () => {
  test('stays well clear of the band beneath it, and steps on a laptop', () => {
    // WHY: at the stock 24px rung the title was only twice its own caption once
    // the band dropped to the review rungs, and the page read as one flat block
    // rather than a sentence with supporting facts under it.
    const headings = readFileSync(join(REVIEW_DIR, 'ActivityFeed.svelte'), 'utf8')
      .split(/\n/)
      .filter((line) => line.includes('tracking-[-0.023em]'))
    // The rendered title and the edit field must agree, or the sentence jumps
    // size the moment you click Edit.
    expect(headings).toHaveLength(2)
    for (const line of headings) {
      expect(line).toContain('text-[29px]')
      expect(line).toContain('[.is-laptop-display_&]:text-2xl')
    }
  })
})
