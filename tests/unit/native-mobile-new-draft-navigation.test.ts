import { describe, expect, test } from 'bun:test'
import { CommonActions, StackActions, StackRouter } from '@react-navigation/routers'
import { isDraftThreadRoute, submittedThreadParams } from '../../apps/mobile/src/features/threads/thread-route-state'
import type { RootStackParamList } from '../../apps/mobile/src/navigation/routes'

const router = StackRouter({ initialRouteName: 'Home' })
const config = { routeNames: ['Home', 'Thread', 'NewTask', 'NewTaskEnvironment'], routeParamList: {}, routeGetIdList: {} }

function draftStack() {
  return router.getRehydratedState({
    stale: true, index: 2,
    routes: [
      { key: 'home-mounted', name: 'Home' },
      { key: 'thread-mounted', name: 'Thread', params: { hostId: 'host', sessionId: 'previous-session' } },
      { key: 'draft-mounted', name: 'Thread', params: {
        hostId: 'host', sessionId: 'new-session', draft: { projectPath: '/repo' },
      } },
    ],
  }, config)
}

describe('T3 draft-to-live navigation', () => {
  test('submission changes params without replacing any native screen or the stack', () => {
    const before = draftStack()
    const next = router.getStateForAction(before, {
      ...CommonActions.setParams(submittedThreadParams('host', 'new-session')),
      source: 'draft-mounted',
    }, config)!
    expect(next.key).toBe(before.key)
    expect(next.index).toBe(before.index)
    expect(next.routes).toHaveLength(before.routes.length)
    expect(next.routes[0]).toBe(before.routes[0])
    expect(next.routes[1]).toBe(before.routes[1])
    expect(next.routes[2]!.key).toBe('draft-mounted')
    expect(next.routes[2]!.name).toBe('Thread')
    expect(next.routes[2]!.params).toEqual({ hostId: 'host', sessionId: 'new-session', draft: undefined })
    expect(before.routes[2]!.params).toHaveProperty('draft', { projectPath: '/repo' })
  })

  test('a host picker returns to the draft screen with its key and task binding intact', () => {
    const before = draftStack()
    const picked = router.getStateForAction(before, StackActions.push('NewTaskEnvironment', { hostId: 'host', projectPath: '/repo' }), config)!
    const params: RootStackParamList['Thread'] = {
      hostId: 'other-host', sessionId: 'new-session',
      draft: { projectPath: '/other/repo', taskId: 'task', taskHostId: 'task-host', hostChoice: 'manual' },
    }
    const returned = router.getStateForAction(picked, StackActions.popTo('Thread', params), config)!
    expect(returned.routes).toHaveLength(3)
    expect(returned.routes[2]!.key).toBe('draft-mounted')
    expect(returned.routes[2]!.params).toEqual(params)
  })

  test('only an unsubmitted Thread is a draft', () => {
    expect(isDraftThreadRoute({ key: 'draft', name: 'Thread', params: { hostId: 'host', sessionId: 'new', draft: { projectPath: '/repo' } } })).toBe(true)
    expect(isDraftThreadRoute({ key: 'live', name: 'Thread', params: submittedThreadParams('host', 'new') })).toBe(false)
    expect(isDraftThreadRoute({ key: 'picker', name: 'NewTask', params: { hostId: 'host' } })).toBe(false)
  })
})
