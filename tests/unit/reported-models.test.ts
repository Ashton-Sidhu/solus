import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { AgentBackend } from '@solus/server/execution/agents/agent-backend'
import type { TurnSeat } from '@solus/server/execution/seats/seat-manager'
import { refreshReportedModels } from '@solus/server/execution/agents/reported-models'

function backendWith(refreshModels?: (seat?: TurnSeat) => Promise<void>): AgentBackend {
  return Object.assign(new EventEmitter(), { id: 'antigravity', refreshModels }) as unknown as AgentBackend
}

// WHY: the host asks again at boot, after every sign-in, and on each "refresh
// the model list". None of those may break when the agent cannot answer: the
// last list stays and the host goes on.
test('a refresh after a sign-in asks with that seat, and a failure stays quiet', async () => {
  const seat = { home: '/profiles/member' } as TurnSeat
  const asked: Array<TurnSeat | undefined> = []
  await refreshReportedModels(backendWith(async (given) => { asked.push(given) }), seat)
  expect(asked).toEqual([seat])

  await expect(refreshReportedModels(backendWith(async () => { throw new Error('agy exited') }), seat)).resolves.toBeUndefined()
})

test('an agent that reports its models with every turn is not asked', async () => {
  await expect(refreshReportedModels(backendWith(undefined))).resolves.toBeUndefined()
})
