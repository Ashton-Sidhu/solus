import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const workspaceCss = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/index.css'),
  'utf8',
)
const toolGroup = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/conversation/ToolGroupItem.svelte'),
  'utf8',
)
const activityRow = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/conversation/ActivityRow.svelte'),
  'utf8',
)

describe('tool group laptop typography', () => {
  test('keeps the outer activity label one rung above nested tool activity', () => {
    // WHY: the turn summary is the primary status at 13px (11px on laptops),
    // while nested tool activity is supporting detail at 12px (10px on laptops).
    expect(workspaceCss).toContain('--text-activity-label: 0.8125rem;')
    expect(workspaceCss).toMatch(
      /@media \(pointer: fine\)[\s\S]*?html\.is-laptop-display\s*{[\s\S]*?--text-activity-label: 0\.6875rem;/,
    )
    expect(activityRow).toMatch(
      /\.activity-label\s*{[\s\S]*?font-size: var\(--text-activity-label\);/,
    )
    expect(activityRow).toMatch(
      /\.activity-row\.is-nested \.activity-label\s*{[\s\S]*?font-size: var\(--text-tool-step\);/,
    )
    expect(toolGroup).toContain('nested={!working && !runningTool}')
    expect(activityRow).toContain(
      '--activity-icon-size: var(--text-activity-label);',
    )
    expect(activityRow).toMatch(
      /\.activity-row\.is-nested\s*{\s*--activity-icon-size: var\(--text-tool-step\);/,
    )
    expect(activityRow).toMatch(
      /\.activity-glyph :global\(svg\)\s*{[\s\S]*?width: var\(--activity-icon-size\);[\s\S]*?height: var\(--activity-icon-size\);/,
    )
    expect(activityRow).toMatch(
      /:global\(\.activity-spinner\)\s*{[\s\S]*?width: var\(--activity-icon-size\);[\s\S]*?height: var\(--activity-icon-size\);/,
    )
  })

  test('scales individual tool calls down only on precise-pointer laptops', () => {
    // WHY: expanded tool traces are secondary diagnostic detail. They can use
    // less horizontal space on laptops, but touch and large displays must keep
    // the existing readable size.
    expect(workspaceCss).toContain('--text-tool-step: 0.75rem;')
    expect(workspaceCss).toMatch(
      /@media \(pointer: fine\)[\s\S]*?html\.is-laptop-display\s*{[\s\S]*?--text-tool-step: 0\.625rem;/,
    )
    expect(toolGroup).toContain('class="tool-step-text text-tool-step font-mono"')
    expect(toolGroup).toContain(
      'class="tool-step-duration text-tool-step font-mono shrink-0"',
    )
    expect(activityRow).toMatch(
      /\.activity-target\s*{[\s\S]*?font-size: var\(--text-tool-step\);/,
    )
    expect(toolGroup).toMatch(
      /\.tool-step-glyph :global\(svg\)\s*{[\s\S]*?width: var\(--text-tool-step\);[\s\S]*?height: var\(--text-tool-step\);/,
    )
  })
})
