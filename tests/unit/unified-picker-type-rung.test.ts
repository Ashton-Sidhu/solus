import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The unified picker was drawn against a design system whose type scale is
// specified in literal pixels — 9.5, 10.5, 11, 11.5, 13.5, 14.5 — and the first
// implementation transcribed those values as arbitrary Tailwind sizes, with a
// second `max-md:` size stacked on top of each for the phone.
//
// `index.css` refuses that scale on purpose. The note over `--text-micro` says
// it: "10px, not the design system's literal 9.5 or 10.5 … two neighbouring
// rungs half a pixel apart are a choice nobody can make and no display can
// render". The rungs also already carry the phone, because every one of them
// holds its desktop size under `(pointer: coarse)` — so a `max-md:` size on top
// of a rung is not a mobile adaptation, it is the rung being overwritten at the
// one width it was built for.
//
// These tests pin the mapping, not the pixels: the picker picks named rungs and
// never restates what one means. Each rung below was chosen against the value
// `Unified Picker.dc.html` actually draws, so the spec and the ladder agree on
// the *order* of the sizes even where they disagree on the exact pixel.

const UI = new URL('../../packages/workspace-ui/src/', import.meta.url).pathname
const PICKER = `${UI}components/session/unified-picker/`

const sources = {
  'UnifiedPicker.svelte': readFileSync(`${PICKER}UnifiedPicker.svelte`, 'utf8'),
  'UnifiedPickerRow.svelte': readFileSync(`${PICKER}UnifiedPickerRow.svelte`, 'utf8'),
  'TaskPreviewPane.svelte': readFileSync(`${PICKER}TaskPreviewPane.svelte`, 'utf8'),
  'PickerActionBar.svelte': readFileSync(`${PICKER}PickerActionBar.svelte`, 'utf8'),
  'PickerPeekSheet.svelte': readFileSync(`${PICKER}PickerPeekSheet.svelte`, 'utf8'),
}

// The two sizes on this surface that are deliberately not a rung.
//
// `text-[1.1875rem]` is the task preview's title. It is content, not chrome, and
// no chrome rung goes up to 19px.
//
// `max-md:text-base` is the search field. iOS Safari zooms the page whenever a
// focused input resolves under 16px, and no chrome rung is that large, so this
// is a platform requirement rather than a styling choice.
const ALLOWED_LITERAL_SIZES = new Set(['text-[1.1875rem]', 'max-md:text-base'])

// A `text-*` suffix that names a font size rather than a colour: a stock scale
// step, a bracketed literal, or one of the named rungs in `index.css`.
const SIZE_SUFFIX =
  /^(?:xs|sm|base|lg|xl|[2-9]xl|\[[0-9]|workspace-chrome|micro|chrome-shelf|chrome-dense|menu)$|^\[[0-9]/

const literalSizes = (source: string) => [
  ...source.matchAll(/(?:max-md:|md:|sm:|lg:)?text-\[[0-9][^\]]*\]/g),
].map((match) => match[0])

describe('unified picker typography', () => {
  test('no literal font size survives outside the two documented exceptions', () => {
    // WHY: this is the defect the design import introduced. A literal size does
    // not follow the laptop step, does not follow the coarse-pointer guard, and
    // does not move when the ladder is retuned — so the picker drifts away from
    // every surface beside it, silently, on exactly one class of display.
    for (const [file, source] of Object.entries(sources)) {
      const offenders = literalSizes(source).filter((size) => !ALLOWED_LITERAL_SIZES.has(size))
      expect({ file, offenders }).toEqual({ file, offenders: [] })
    }
  })

  test('no stock Tailwind size is used where a rung exists', () => {
    // WHY: `text-xs` and `text-sm` are fixed at 12px and 14px. They cannot step
    // down on a laptop or hold their size on touch, which is the whole reason
    // the named rungs exist.
    for (const [file, source] of Object.entries(sources)) {
      const offenders = [...source.matchAll(/(?:^|[\s"'])((?:max-md:)?text-(?:xs|sm))(?=[\s"'])/g)]
        .map((match) => match[1])
      expect({ file, offenders }).toEqual({ file, offenders: [] })
    }
  })

  test('the phone never restates a size over a rung', () => {
    // WHY: every rung already holds its readable desktop size under
    // `(pointer: coarse)`. A `max-md:` size is therefore not mobile support —
    // it overrides the rung at the width the rung was tuned for, and it fires on
    // a narrow *window* rather than on a phone, so it also hits a desktop user
    // who drags the app narrow.
    for (const [file, source] of Object.entries(sources)) {
      const offenders = [...source.matchAll(/max-md:text-[^\s"'{}]+/g)]
        .map((match) => match[0])
        // Colour utilities share the `text-` prefix; only sizes are in scope.
        .filter((token) => SIZE_SUFFIX.test(token.slice('max-md:text-'.length)))
        .filter((token) => !ALLOWED_LITERAL_SIZES.has(token))
      expect({ file, offenders }).toEqual({ file, offenders: [] })
    }
  })

  test('uppercase section headings take the micro rung, not the shelf rung', () => {
    // WHY: `Unified Picker.dc.html` draws every uppercase heading on this
    // surface — the list's section heads and the preview's "Sessions"/"Linked"
    // heads — at 9.5px with 0.13em tracking, on both the desktop overlay and the
    // phone. That is the micro rung, and the letterspacing is what makes a 10px
    // cap legible; `--text-chrome-shelf` is 12px and reads as a second row.
    for (const file of ['UnifiedPickerRow.svelte', 'TaskPreviewPane.svelte'] as const) {
      expect(sources[file]).toContain('text-micro font-medium tracking-[0.13em] uppercase')
      expect(sources[file]).not.toContain('text-chrome-shelf')
    }
  })

  test('row annotations take the micro rung', () => {
    // WHY: a relative timestamp, a session count and a project label annotate
    // the row rather than saying what it is, which is the micro rung's stated
    // job. The cue is the gap to the row's own rung — pin it so a later change
    // cannot close it by promoting the annotation.
    const row = sources['UnifiedPickerRow.svelte']
    expect(row).toContain('text-micro')
    // The title and the session label are what the row says; they stay chrome.
    expect(row).toContain('text-workspace-chrome font-medium text-foreground')
  })

  test('the footer hint band keeps a rung over its keycaps', () => {
    // WHY: the spec draws the hint label at 11.5px over a 10px keycap. `Kbd`
    // already puts the keycap on `text-micro`, so the label takes the shelf rung
    // — the one place on this surface where 12px is right, because closing that
    // gap makes the key compete with the word it explains. It is also what the
    // command palette's footer does, and the two open over the same workspace.
    expect(sources['UnifiedPicker.svelte']).toContain(
      'text-chrome-shelf text-muted-foreground max-md:hidden',
    )
  })

  test('the phone shell names the spec background token', () => {
    // WHY: the spec fills the phone artboard with `var(--background)`. That
    // already resolves to `--solus-container-bg` in `index.css`, so this is the
    // same paint either way — but naming the shared token means a later change
    // to the app background carries the picker with it instead of stranding it.
    expect(sources['UnifiedPicker.svelte']).toContain('max-md:bg-background')
    // The desktop overlay is a popover, and the spec fills it as one.
    expect(sources['UnifiedPicker.svelte']).toContain('bg-popover')
  })
})
