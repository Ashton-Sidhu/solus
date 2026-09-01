import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const UI = new URL('../../packages/workspace-ui/src/', import.meta.url).pathname

const overlays = [
  'components/pickers/DirectoryPicker.svelte',
  'components/session/SessionPicker.svelte',
  'components/session/TaskPicker.svelte',
  'components/project-panel/commit-composer/CommitComposer.svelte',
  'components/project-panel/publish-repository/PublishRepositoryDialog.svelte',
]

describe('window-centred overlays', () => {
  test.each(overlays)('%s centres on its full-window scrim', (path) => {
    const source = readFileSync(`${UI}${path}`, 'utf8')

    // WHY: padding the scrim to a conversation pane shifts a picker when a side
    // pane is open. The full-window flex box is the stable app-window centre.
    expect(source).toMatch(/fixed inset-0[^"\n]*flex items-center justify-center/u)
    expect(source).not.toContain('style={centringStyle}')
    expect(source).not.toContain('observeConversationBounds')
  })
})
