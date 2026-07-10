import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AttentionService, attentionActionForStatus } from '../../src/main/attention/attention-service'
import type { AttentionEntry } from '../../src/shared/attention-types'

describe('attentionActionForStatus — status → attention entry kind', () => {
  test('awaiting_input maps to the pending prompt kind', () => {
    expect(attentionActionForStatus('awaiting_input', 'permission')).toEqual({ type: 'set', kind: 'needs_approval' })
    expect(attentionActionForStatus('awaiting_input', 'question')).toEqual({ type: 'set', kind: 'question' })
    // awaiting_input with nothing pending isn't actionable (e.g. a plan-only wait).
    expect(attentionActionForStatus('awaiting_input', null)).toEqual({ type: 'ignore' })
  })

  test('terminal states create finished/failed entries', () => {
    expect(attentionActionForStatus('completed', null)).toEqual({ type: 'set', kind: 'finished' })
    expect(attentionActionForStatus('failed', null)).toEqual({ type: 'set', kind: 'failed' })
    expect(attentionActionForStatus('dead', null)).toEqual({ type: 'set', kind: 'failed' })
  })

  test('active/neutral states resolve — covers respond, next-prompt, and cancel', () => {
    // respond (→ running) and next-prompt (→ running/connecting) both clear.
    expect(attentionActionForStatus('running', 'permission')).toEqual({ type: 'resolve' })
    expect(attentionActionForStatus('connecting', null)).toEqual({ type: 'resolve' })
    expect(attentionActionForStatus('idle', null)).toEqual({ type: 'resolve' })
    // cancel/stop (→ interrupted) clears.
    expect(attentionActionForStatus('interrupted', null)).toEqual({ type: 'resolve' })
  })

  test('non-attention states are ignored', () => {
    expect(attentionActionForStatus('awaiting_plan', null)).toEqual({ type: 'ignore' })
    expect(attentionActionForStatus('rate_limited', null)).toEqual({ type: 'ignore' })
  })
})

describe('AttentionService — entry lifecycle + persistence', () => {
  let dir: string
  let statePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solus-attention-'))
    statePath = join(dir, 'state', 'attention.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('set records an active entry and notifies listeners with the full list', () => {
    const svc = new AttentionService(statePath)
    const changes: AttentionEntry[][] = []
    svc.onChange((entries) => changes.push(entries))

    svc.set({ sessionId: 's1', kind: 'needs_approval', summary: 'Approval needed: Bash', projectKey: '/repo' })

    const entry = svc.get('s1')!
    expect(entry.kind).toBe('needs_approval')
    expect(entry.summary).toBe('Approval needed: Bash')
    expect(entry.projectKey).toBe('/repo')
    expect(entry.since).toBeGreaterThan(0)
    expect(svc.list()).toHaveLength(1)
    expect(changes.at(-1)).toHaveLength(1)
  })

  test('latest wins — a new kind replaces the entry and resets `since`', async () => {
    const svc = new AttentionService(statePath)
    svc.set({ sessionId: 's1', kind: 'needs_approval', summary: 'Approval needed' })
    const first = svc.get('s1')!.since

    await Bun.sleep(2)
    svc.set({ sessionId: 's1', kind: 'finished', summary: 'Turn finished' })
    const second = svc.get('s1')!
    expect(second.kind).toBe('finished')
    expect(second.since).toBeGreaterThan(first)
    expect(svc.list()).toHaveLength(1)
  })

  test('re-asserting an identical entry is a no-op (no extra broadcast)', () => {
    const svc = new AttentionService(statePath)
    const changes: AttentionEntry[][] = []
    svc.onChange((entries) => changes.push(entries))

    svc.set({ sessionId: 's1', kind: 'question', summary: 'Question: pick one' })
    svc.set({ sessionId: 's1', kind: 'question', summary: 'Question: pick one' })
    expect(changes).toHaveLength(1)
  })

  test('resolve clears the entry and broadcasts the shorter list', () => {
    const svc = new AttentionService(statePath)
    const changes: AttentionEntry[][] = []
    svc.set({ sessionId: 's1', kind: 'needs_approval', summary: 'Approval needed' })
    svc.set({ sessionId: 's2', kind: 'finished', summary: 'Turn finished' })
    svc.onChange((entries) => changes.push(entries))

    svc.resolve('s1')
    expect(svc.get('s1')).toBeUndefined()
    expect(svc.list().map((e) => e.sessionId)).toEqual(['s2'])
    expect(changes.at(-1)).toHaveLength(1)

    // Resolving an absent session is a no-op — no extra broadcast.
    svc.resolve('s1')
    expect(changes).toHaveLength(1)
  })

  test('state round-trips across a simulated restart (new instance, same file)', () => {
    const first = new AttentionService(statePath)
    first.set({ sessionId: 's1', kind: 'needs_approval', summary: 'Approval needed: Write', projectKey: '/repo' })
    first.set({ sessionId: 's2', kind: 'failed', summary: 'Run failed' })

    // Sanity: the file exists and holds both entries.
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(Object.keys(raw.entries)).toHaveLength(2)

    const restarted = new AttentionService(statePath)
    expect(restarted.list().map((e) => e.sessionId).sort()).toEqual(['s1', 's2'])
    const s1 = restarted.get('s1')!
    expect(s1.kind).toBe('needs_approval')
    expect(s1.projectKey).toBe('/repo')

    // A resolve on the restarted instance persists too.
    restarted.resolve('s2')
    const afterResolve = new AttentionService(statePath)
    expect(afterResolve.list().map((e) => e.sessionId)).toEqual(['s1'])
  })
})
