import { describe, expect, test } from 'bun:test'
import { focusStartedDraft } from '../../packages/workspace-ui/src/components/session-draft/lib/focus-started-draft'

function pendingRender() {
  let mount = () => {}
  const complete = new Promise<void>((resolve) => { mount = resolve })
  return { complete, mount }
}

describe('focus after a draft becomes a session', () => {
  test('waits for the new composer to mount before sending its focus request', async () => {
    const render = pendingRender()
    let hasMountedComposer = false
    const focusedTabs: string[] = []
    const handoff = focusStartedDraft('new-tab', render.complete, () => 'new-tab', ({ tabId }) => {
      // Before mount, no listener exists and a focus request would be lost.
      expect(hasMountedComposer).toBe(true)
      focusedTabs.push(tabId)
    })
    expect(focusedTabs).toEqual([])
    hasMountedComposer = true
    render.mount()
    await handoff
    expect(focusedTabs).toEqual(['new-tab'])
  })

  test('does not steal focus if the user moved to another tab during the handoff', async () => {
    const render = pendingRender()
    let focusedTab: string | null = 'new-tab'
    const focusedTabs: string[] = []
    const handoff = focusStartedDraft('new-tab', render.complete, () => focusedTab, ({ tabId }) => focusedTabs.push(tabId))
    focusedTab = 'another-tab'
    render.mount()
    await handoff
    expect(focusedTabs).toEqual([])
  })

  test('does not focus a hidden chat when another route owns the pane', async () => {
    const focusedTabs: string[] = []
    await focusStartedDraft('new-tab', Promise.resolve(), () => null, ({ tabId }) => focusedTabs.push(tabId))
    expect(focusedTabs).toEqual([])
  })
})
