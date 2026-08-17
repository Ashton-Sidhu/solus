import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  LAPTOP_QUERY,
  LAPTOP_VIEWPORT_MAX_WIDTH,
} from '../../src/renderer/contexts/app/viewport'

const readRendererSource = (path: string) =>
  readFileSync(join(import.meta.dir, '../../src/renderer', path), 'utf8')

describe('laptop viewport styling', () => {
  test('includes the 15-inch MacBook Pro 1512 × 982 display mode', () => {
    // WHY: browser media queries use logical CSS pixels. The laptop's height
    // does not change horizontal layout classification; its 1512px width is the
    // value every desktop and web surface receives.
    expect(1512).toBeLessThanOrEqual(LAPTOP_VIEWPORT_MAX_WIDTH)
    expect(LAPTOP_QUERY).toBe('(max-width: 1800px)')
  })

  test('pill mode reads the shared laptop classification', () => {
    const source = readRendererSource('components/layout/PillLayout.svelte')
    expect(source).toContain('runtime.isLaptopViewport')
    expect(source).not.toMatch(/workAreaWidth\s*<\s*1800/)
  })

  test('plan styling reads the root laptop classification', () => {
    const source = readRendererSource('components/plan/PlanModal.css')
    expect(source).toContain('html.is-laptop-viewport .plan-shell')
    expect(source).not.toContain('@media (max-width: 1800px)')
  })

  test('runtime publishes the classification for CSS on every client', () => {
    const source = readRendererSource('contexts/app/runtime.svelte.ts')
    expect(source).toContain(
      "document.documentElement.classList.toggle('is-laptop-viewport', isLaptopViewport)",
    )
    expect(source).toContain('listen(LAPTOP_QUERY, setLaptopViewport)')
  })
})
