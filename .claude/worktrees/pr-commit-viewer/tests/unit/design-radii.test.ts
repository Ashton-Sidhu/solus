import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const rendererRoot = join(import.meta.dir, '../../src/renderer')

function rendererSources(directory: string): Array<{ path: string; source: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return rendererSources(path)
    if (!entry.name.endsWith('.svelte') && !entry.name.endsWith('.css')) return []
    return [{ path, source: readFileSync(path, 'utf8') }]
  })
}

describe('interface radius standard', () => {
  test('maps navigation and card tokens to scalable 8px and 16px radii', () => {
    // WHY: Radius utilities must follow the fluid root font size instead of
    // freezing a physical pixel value at one display scale.
    const css = readFileSync(join(rendererRoot, 'index.css'), 'utf8')
    expect(css).toContain('--radius: 0.5rem;')
    expect(css).toContain('--radius-md: var(--radius);')
    expect(css).toContain('--radius-lg: var(--radius);')
    expect(css).toContain('--radius-xl: 1rem;')
  })

  test('keeps navigation rows and primary card surfaces on their semantic radii', () => {
    // WHY: These high-traffic surfaces are the reference implementation for
    // the rest of the renderer and make radius drift immediately visible.
    const sidebar = readFileSync(
      join(rendererRoot, 'components/session/SessionSidebar.svelte'),
      'utf8',
    )
    const taskCard = readFileSync(
      join(rendererRoot, 'components/tasks/TaskBoardCard.svelte'),
      'utf8',
    )
    const interruptCard = readFileSync(
      join(rendererRoot, 'components/conversation/InterruptCard.svelte'),
      'utf8',
    )
    expect(sidebar).not.toContain('rounded-[0.5625rem]')
    expect(sidebar).toContain('rounded-lg')
    expect(taskCard).toContain('rounded-2xl')
    expect(interruptCard).toContain('rounded-2xl')
  })

  test('does not introduce fixed-pixel arbitrary radius utilities', () => {
    // WHY: A fixed-pixel radius does not scale with Solus UI scaling.
    const offenders = rendererSources(rendererRoot).flatMap(({ path, source }) =>
      /rounded-\[[0-9.]+px\]/.test(source) ? [path] : [],
    )
    expect(offenders).toEqual([])
  })

  test('keeps shared buttons non-pill-shaped', () => {
    // WHY: The product decision for this standard keeps buttons at the 8px
    // navigation radius instead of making every button a pill.
    const button = readFileSync(
      join(rendererRoot, 'components/ui/button/button.svelte'),
      'utf8',
    )
    expect(button).toMatch(/base: "[^"]*rounded-lg[^"]*"/)
    expect(button).not.toMatch(/base: "[^"]*rounded-full[^"]*"/)
  })
})
