import { describe, expect, test } from 'bun:test'
import { newTaskBalanceCandidates, newTaskHostLabel, settleNewTaskBalance, shouldBalanceNewTask, type NewTaskBalanceDraft } from '../../apps/mobile/src/features/threads/lib/new-task-balance-candidates'

// Mobile chooses by the same rule as desktop and web: the same hosts must be
// eligible on each client, or one preference means two things.

const environment = (hostId: string) => ({ hostId, projectPath: '/repo' })
const host = (id: string, change: object = {}) => ({ id, ready: true, runsAgent: true, ...change })

describe('new-task balance candidates', () => {
  test('keeps connected hosts that hold the project, with their preference', () => {
    expect(newTaskBalanceCandidates([environment('a')], [host('a')], { enabled: true, preferences: { a: 'prefer' } }))
      .toEqual([{ hostId: 'a', projectPath: '/repo', preference: 'prefer' }])
  })

  test('leaves out Manual only, a host that is down, one without the agent, and managed compute that is not ready', () => {
    const hosts = [
      host('manual'),
      host('down', { ready: false }),
      host('noagent', { runsAgent: false }),
      host('managed', { uplink: { hostId: 'm', directoryUrl: 'x', kind: 'managed', managedState: 'provisioning' } }),
    ]
    expect(newTaskBalanceCandidates(hosts.map((item) => environment(item.id)), hosts, { enabled: true, preferences: { manual: 'manual' } })).toEqual([])
  })

  test('an environment whose host this phone does not list is not a candidate', () => {
    expect(newTaskBalanceCandidates([environment('unknown')], [], { enabled: true, preferences: {} })).toEqual([])
  })
})

describe('when a new task checks', () => {
  test('a new task nobody has placed checks once', () => {
    expect(shouldBalanceNewTask({ balanceRequest: undefined, hostChoice: undefined, startedEmpty: true })).toBe(true)
  })

  test('a choice stays, so the draft does not move again', () => {
    expect(shouldBalanceNewTask({ balanceRequest: undefined, hostChoice: 'manual', startedEmpty: true })).toBe(false)
    expect(shouldBalanceNewTask({ balanceRequest: undefined, hostChoice: 'auto', startedEmpty: true })).toBe(false)
  })

  test('a saved draft keeps its host, which the person may have chosen', () => {
    expect(shouldBalanceNewTask({ balanceRequest: undefined, hostChoice: undefined, startedEmpty: false })).toBe(false)
  })

  test('the picker row always checks', () => {
    expect(shouldBalanceNewTask({ balanceRequest: 1, hostChoice: undefined, startedEmpty: false })).toBe(true)
  })

  test('the host chip says what the check is doing, as Run on does', () => {
    expect(newTaskHostLabel('checking', 'Mac')).toBe('Checking hosts…')
    expect(newTaskHostLabel('unavailable', 'Mac')).toBe('Auto balance unavailable')
    expect(newTaskHostLabel('idle', 'Mac')).toBe('Mac')
  })
})

describe('what a finished check does to a new task', () => {
  const draft = (change: Partial<NewTaskBalanceDraft> = {}): NewTaskBalanceDraft => ({
    hostId: 'a', draftKey: 'new-task:/repo', text: '', attachments: 0, submitting: false, requested: false, ...change,
  })
  const settle = (from: NewTaskBalanceDraft, chosenHostId = 'b') => {
    const saved: [string, string][] = []
    const params: object[] = []
    const applied = settleNewTaskBalance({ hostId: chosenHostId, projectPath: '/b/repo' }, from, {
      saveDraft: (hostId, _key, text) => saved.push([hostId, text]),
      setParams: (change) => params.push(change),
    })
    return { applied, saved, params: params[0] }
  }

  test('an empty draft moves to the chosen host', () => {
    const { saved, params } = settle(draft())
    expect(params).toMatchObject({ hostId: 'b', projectPath: '/b/repo', hostChoice: 'auto' })
    expect(saved).toContainEqual(['b', ''])
  })

  test('a check never moves a draft the person started to write', () => {
    const { applied, saved, params } = settle(draft({ text: 'fix the login page' }))
    expect(applied).toBe(true)
    expect(saved).toEqual([])
    // The check chose another host, so this one is not marked as its choice.
    expect(params).toEqual({ hostChoice: 'manual', balanceRequest: undefined })
  })

  test('text with only spaces is not writing, as on desktop', () => {
    expect(settle(draft({ text: '   ' })).params).toMatchObject({ hostId: 'b' })
  })

  test('an attachment or a send in progress keeps the draft too', () => {
    expect(settle(draft({ attachments: 1 })).params).toEqual({ hostChoice: 'manual', balanceRequest: undefined })
    expect(settle(draft({ submitting: true })).params).toEqual({ hostChoice: 'manual', balanceRequest: undefined })
  })

  test('a written draft already on the chosen host keeps it as the check choice', () => {
    expect(settle(draft({ text: 'words' }), 'a').params).toEqual({ hostChoice: 'auto', balanceRequest: undefined })
  })

  test('the picker row moves a written draft and its words, because the person asked', () => {
    const { saved, params } = settle(draft({ text: 'words', requested: true }))
    expect(params).toMatchObject({ hostId: 'b', hostChoice: 'auto' })
    expect(saved).toEqual([['a', ''], ['b', 'words']])
  })

  test('the picker row cannot carry attachments, and reports that', () => {
    const { applied, saved, params } = settle(draft({ attachments: 1, requested: true }))
    expect(applied).toBe(false)
    expect(saved).toEqual([])
    expect(params).toBeUndefined()
  })
})
