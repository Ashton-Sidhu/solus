import { expect, test } from 'bun:test'
import { computeCliPathAsync } from '@solus/server/cli-env'

test('the login-shell PATH probe does not wait on stdin', async () => {
  // WHY: the real probe is an interactive login shell. With stdin left open it
  // sits reading it until the timeout kills it, so the "warm" PATH lost the race
  // with the first RPC every boot, and that RPC paid a synchronous shell on the
  // main thread instead — right under the first transcript page. `cat` stands
  // in for that shell: it exits only when stdin is closed.
  const startedAt = performance.now()
  const path = await computeCliPathAsync(['cat >/dev/null; echo /probe/bin'], 2_000)
  expect(path.split(':')).toContain('/probe/bin')
  expect(performance.now() - startedAt).toBeLessThan(1_000)
})

test('a probe that answers nothing falls through to the next one', async () => {
  const path = await computeCliPathAsync(['true', 'echo /second/bin'], 2_000)
  expect(path.split(':')).toContain('/second/bin')
})
