import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const composer = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/tasks/TaskComposer.svelte'),
  'utf8',
)

describe('Task composer — one quiet column', () => {
  test('states every property in one shape, with no resting surface', () => {
    // WHY: the composer's job is to get out of the way of the sentence the user
    // is writing. A property that carries its own border, fill or track becomes
    // a second thing to read; five of them become a form. Each is a word until
    // the pointer reaches it.
    expect(composer).toContain('const PROP =')
    const prop = composer.slice(composer.indexOf('const PROP ='), composer.indexOf('// Square ghost'))
    expect(prop).toContain('bg-transparent')
    expect(prop).toContain('hover:bg-(--solus-surface-hover)')
    expect(prop).not.toContain('border-(')
    expect(prop).not.toContain('shadow-[')
  })

  test('keeps the accent for committing, not for describing', () => {
    // WHY: terracotta means "this does something". Spending it on a header
    // mark, a type toggle and a status glyph leaves nothing for the one button
    // that actually writes the task.
    const header = composer.slice(
      composer.indexOf('<!-- Header:'),
      composer.indexOf('<!-- Body:'),
    )
    // The popovers these triggers open still spend the accent on keyboard
    // focus, which is a state, not a decoration — so this checks the resting
    // controls: the header strip and the shared property shape.
    const prop = composer.slice(composer.indexOf('const PROP ='), composer.indexOf('// Square ghost'))
    expect(header).not.toContain('--solus-accent')
    expect(prop).not.toContain('--solus-accent')
  })

  test('ranks the title above everything else it sits beside', () => {
    // WHY: the title, the description and the caption above them were all
    // rendering at the same weight and the same grey, so the panel read as one
    // undifferentiated block. Three separate signals now separate them: size,
    // weight, and — the one that was silently failing — placeholder colour.
    expect(composer).toContain('text-base leading-[1.3] font-semibold')
    // `input::placeholder` is set unlayered in index.css, and an unlayered
    // declaration outranks any layered utility. Without the `!` the title's
    // placeholder silently fell back to the same grey as the description's.
    expect(composer).toContain('placeholder:text-(--solus-text-secondary)!')
  })

  test('declares the chrome rung once per surface, not per leaf', () => {
    // WHY: a popover portals out of the panel, so it cannot inherit the panel's
    // rung and has to state its own. Stating it again on every row and field
    // inside is what pushed this file over the type-scale ratchet.
    expect(composer).toContain('const MENU_SURFACE = "text-workspace-chrome"')
    expect(composer).not.toMatch(/const OPT =[\s\S]{0,400}text-workspace-chrome/)
  })

  test('names the dialog for assistive tech without printing a caption', () => {
    // WHY: an on-screen "New task" strip repeats what the Type control and the
    // Create button already say, directly above the field the user came to
    // fill in. A screen reader still needs the name, so it moves to the
    // dialog's own label rather than disappearing.
    expect(composer).toContain('aria-label={heading}')
    expect(composer).not.toContain('>{heading}</span')
  })

  test('has no property rail — the columns are gone', () => {
    // WHY: a two-column dialog splits attention between writing and filing at
    // the moment the user only wants to write. Properties follow the
    // description instead of flanking it.
    expect(composer).not.toContain('Property rail')
    expect(composer).toContain('<!-- Properties:')
  })
})
