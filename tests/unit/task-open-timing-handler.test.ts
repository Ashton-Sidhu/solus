import { expect, mock, test } from 'bun:test'
import { SolusServer } from '@solus/server/transport/server'
import { Database } from 'bun:sqlite'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { registerTasksHandlers } = await import('@solus/server/transport/handlers/tasks-handlers')
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'

const server = new SolusServer()
registerTasksHandlers(server, { sync: false })
const timing = {
  activationId: 'activation-a', taskId: 'task-a', outcome: 'completed' as const,
  marks: [{ stage: 'navigation_started', elapsedMs: 32 }],
}

test('client timing is accepted without reading or changing task records', async () => {
  await expect(server.handle('tasksLogOpenTiming', [timing], TEST_HANDLER_CTX)).resolves.toBeUndefined()
})

test('the host refuses unbounded or invalid timing reports', async () => {
  await expect(server.handle('tasksLogOpenTiming', [{ ...timing, marks: Array(33).fill(timing.marks[0]) }], TEST_HANDLER_CTX)).rejects.toThrow()
  await expect(server.handle('tasksLogOpenTiming', [{ ...timing, marks: [{ stage: 'frame', elapsedMs: -1 }] }], TEST_HANDLER_CTX)).rejects.toThrow()
})
