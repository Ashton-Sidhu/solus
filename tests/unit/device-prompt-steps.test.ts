import { describe, expect, test } from 'bun:test'
import { devicePromptSteps } from '../../packages/workspace-ui/src/components/servers/lib/device-prompt-steps'

// The host opens the sign-in page before the prompt shows, so the rail must
// never ask the person to open it again: step 1 is done and step 2 is where
// they are, and it names what the page wants from them.
describe('devicePromptSteps', () => {
  test('the page is already open, so the second step is the current one', () => {
    for (const ask of ['enter-code', 'paste-code', 'approve'] as const) {
      const [opened, next] = devicePromptSteps(ask, false)
      expect(opened.state).toBe('done')
      expect(next.state).toBe('current')
    }
  })

  test('the second step names what the page asks for', () => {
    expect(devicePromptSteps('enter-code', false)[1].title).toMatch(/Enter this code/)
    expect(devicePromptSteps('paste-code', false)[1].title).toMatch(/Paste the code/)
    expect(devicePromptSteps('approve', false)[1].title).toMatch(/Approve/)
  })

  test('once a pasted code is sent, the step says the code is being checked', () => {
    expect(devicePromptSteps('paste-code', true)[1].title).toBe('Checking your code…')
  })
})
