import { describe, expect, test } from 'bun:test'
import { projectFallbackColor } from '../../src/renderer/lib/project-favicon'

describe('project favicon fallback', () => {
  test('keeps a project colour stable when no favicon is available', () => {
    // WHY: filtering or reopening the Tasks page must not repaint a project as
    // a different colour when its own favicon cannot identify it.
    const first = projectFallbackColor('/workspace/solus')
    expect(projectFallbackColor('/workspace/solus')).toBe(first)
    expect(first).toMatch(/^--chart-[1-5]$/)
  })
})
