import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { isLaptopDisplay } from '../../src/renderer/contexts/app/viewport'
import { LAPTOP_SCREEN_MAX_WIDTH } from '../../src/shared/zoom'

const readRendererSource = (path: string) =>
  readFileSync(join(import.meta.dir, '../../src/renderer', path), 'utf8')

// `screen.width` is reported in zoomed CSS pixels, so a display of width W at
// zoom Z reads back as W / Z. These helpers make each case state the real
// hardware and let the test derive what the renderer would see.
const asSeenAtZoom = (displayWidth: number, zoomFactor: number) => displayWidth / zoomFactor

describe('isLaptopDisplay', () => {
  test('classifies the hardware, not the window', () => {
    expect(isLaptopDisplay(1512, 1)).toBe(true) // 14" MacBook Pro
    expect(isLaptopDisplay(1920, 1)).toBe(false)
    expect(isLaptopDisplay(LAPTOP_SCREEN_MAX_WIDTH, 1)).toBe(true)
    expect(isLaptopDisplay(LAPTOP_SCREEN_MAX_WIDTH + 1, 1)).toBe(false)
  })

  // WHY: the old `(max-width: 1800px)` media query measured the window, and zoom
  // changes how many CSS pixels a window reports. A 1920px monitor at 110% zoom
  // reported 1745 and silently crossed onto the laptop branch, so one zoom
  // keystroke also resized the pill and stripped the plan modal's borders.
  test('zoom cannot move a display across the threshold', () => {
    for (const zoomFactor of [0.5, 0.8, 0.9, 1, 1.1, 1.5, 2]) {
      expect(isLaptopDisplay(asSeenAtZoom(1512, zoomFactor), zoomFactor)).toBe(true)
      expect(isLaptopDisplay(asSeenAtZoom(1920, zoomFactor), zoomFactor)).toBe(false)
    }
  })

  test('the window-measuring bug would have flipped the 1920 monitor', () => {
    // Guards the premise of the test above: at 110% the old query really did
    // classify this monitor as a laptop, so the fix is not cosmetic.
    expect(asSeenAtZoom(1920, 1.1)).toBeLessThanOrEqual(1800)
  })

  test('an unreadable screen width is unknown, not narrow', () => {
    expect(isLaptopDisplay(undefined, 1)).toBe(false)
    expect(isLaptopDisplay(Number.NaN, 1)).toBe(false)
    expect(isLaptopDisplay(0, 1)).toBe(false)
  })
})

describe('one shared classification', () => {
  test('pill mode reads the runtime classification rather than its own width rule', () => {
    const source = readRendererSource('components/layout/PillLayout.svelte')
    expect(source).toContain('runtime.isLaptopDisplay')
    expect(source).not.toMatch(/workAreaWidth\s*<\s*1800/)
  })

  test('plan styling reads the root classification rather than its own media query', () => {
    const source = readRendererSource('components/plan/PlanModal.css')
    expect(source).toContain('html.is-laptop-display .plan-shell')
    expect(source).not.toContain('@media (max-width: 1800px)')
  })

  test('document outlines use a compact expanded layout on laptop displays', () => {
    // WHY: the shared outline opens at the top of both plans and documents. Its
    // desktop dimensions consume too much of the reading column on a laptop.
    const source = readRendererSource('components/document-shell/DocumentOutline.svelte')
    expect(source).toContain(':global(html.is-laptop-display) .doc-outline__panel')
    expect(source).toContain('--outline-panel-w: 14.5rem')
    expect(source).toContain(':global(html.is-laptop-display) .doc-outline__item')
    expect(source).toContain('class="doc-outline__item text-workspace-chrome"')
  })

  test('the collapsed diagram inspector rail is compact on laptop displays, and names its selection without turning text on its side', () => {
    // WHY: the rail floats over the canvas, so its width is drawing area the
    // user cannot recover by resizing. It is also only 3rem wide, which is why
    // the name belongs in hover text: at that width every label was either
    // ellipsised mid-word or rotated 90 degrees to fit.
    const source = readRendererSource('components/diagram/inspector/DiagramInspectorRail.svelte')
    expect(source).toContain(':global(html.is-laptop-display) .diagram-rail')
    expect(source).toContain('width: 2.625rem')
    expect(source).toContain('title="{label} — {kindWord}"')
    expect(source).not.toContain('writing-mode')
  })

  test('list search typography uses the shared workspace chrome rung', () => {
    // WHY: search fields must stay on the same laptop, desktop, and touch-client
    // scale as the rest of the persistent workspace controls.
    const source = readRendererSource('components/ui/list-page/ListFilterBar.svelte')
    expect(source).toContain('text-workspace-chrome')
    expect(source).not.toContain('md:text-sm')
  })

  test('session picker uses more laptop width without changing mobile or large desktop defaults', () => {
    // WHY: the session preview needs more horizontal room on a laptop, but the
    // picker must remain full-screen on narrow clients and 75% on large displays.
    const source = readRendererSource('components/session/SessionPicker.svelte')
    expect(source).toContain('w-3/4')
    expect(source).toContain('md:pointer-fine:[.is-laptop-display_&]:w-[85%]')
    expect(source).toContain('max-md:w-full')
  })

  test('runtime publishes the classification to CSS on every client', () => {
    const source = readRendererSource('contexts/app/runtime.svelte.ts')
    expect(source).toContain("classList.toggle('is-laptop-display', next)")
  })
})
