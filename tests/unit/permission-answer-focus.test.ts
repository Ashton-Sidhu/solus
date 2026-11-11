import { afterAll, describe, expect, mock, test } from 'bun:test'

/**
 * Answering a permission card with the mouse disables the clicked option, and
 * then the card leaves the transcript. Focus would fall to the page body and
 * the next keystroke would go nowhere, so an accepted answer returns focus to
 * the composer of its tab (pingdotgg/t3code#33192). A refused answer keeps the
 * card open for a retry, so focus stays on it.
 */

mock.module('@solus/workspace-ui/lib/analytics', () => ({ track: () => {} }))
mock.module('@solus/workspace-ui/lib/toasts', () => ({ toasts: { error: () => {}, success: () => {} } }))

const focusRequests: Array<string | undefined> = []
mock.module('@solus/workspace-ui/lib/inputFocus', () => ({
  FOCUS_INPUT_EVENT: 'solus:focus-input',
  requestInputFocus: (target?: { tabId?: string }) => { focusRequests.push(target?.tabId) },
  blurActiveTextInputOnMobile: () => {},
}))
// The stores this module reaches are plain objects here: no test reads their reactivity.
const globals = globalThis as unknown as { $state?: unknown; $derived?: unknown; $effect?: unknown }
const previous = { $state: globals.$state, $derived: globals.$derived, $effect: globals.$effect }
globals.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value, raw: <T>(value: T) => value })
globals.$derived = Object.assign(<T>(value: T) => value, { by: <T>(fn: () => T) => fn() })
globals.$effect = Object.assign(() => {}, { root: () => () => {}, pre: () => {}, tracking: () => false })
afterAll(() => Object.assign(globals, previous))

const { SessionControls } = await import('@solus/workspace-ui/contexts/workspace/session-controls')

function controls(hostAnswers: boolean) {
  const session = { permissionQueue: [{ questionId: 'q1' }, { questionId: 'q2' }] }
  const ctx = { session: { sessionId: 'session-1' } }
  const workspace = {
    ctxFor: () => ctx,
    apiFor: () => ({ respondPermission: async () => hostAnswers }),
    sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
  }
  // SAFETY: SessionControls reads only ctxFor, apiFor and sessionFor on this path.
  return { controls: new SessionControls(workspace as unknown as ConstructorParameters<typeof SessionControls>[0]), session }
}

describe('answering a permission card', () => {
  test('an accepted answer returns focus to the composer of its tab', async () => {
    focusRequests.length = 0
    const { controls: sessionControls, session } = controls(true)
    expect(await sessionControls.respondPermission('tab-1', 'q1', 'allow')).toBe(true)
    expect(session.permissionQueue.map((request) => request.questionId)).toEqual(['q2'])
    expect(focusRequests).toEqual(['tab-1'])
  })

  test('a refused answer leaves the card open and focus where it is', async () => {
    focusRequests.length = 0
    const { controls: sessionControls, session } = controls(false)
    expect(await sessionControls.respondPermission('tab-1', 'q1', 'allow')).toBe(false)
    expect(session.permissionQueue).toHaveLength(2)
    expect(focusRequests).toEqual([])
  })
})
