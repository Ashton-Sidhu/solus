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

test('the PATH probe runs where the server runs: an ES module under Node', () => {
  // WHY: the shipped server is an ES module, where `require` does not exist.
  // Bun defines it anyway, so the tests above cannot see a bare `require`. One
  // in the probe made every CLI version read throw, and a manual update check
  // reported "up to date" and "Update check failed" at the same time.
  const node = Bun.which('node')
  if (!node) throw new Error('This test requires Node.js.')
  const moduleUrl = new URL('../../packages/server/src/cli-env.ts', import.meta.url).href
  const script = `const { computeCliPathAsync } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(await computeCliPathAsync(['echo /probe/bin'], 2000))`
  const result = Bun.spawnSync([node, '--input-type=module', '-e', script])
  expect(result.stderr.toString()).toBe('')
  expect(result.stdout.toString().split(':')).toContain('/probe/bin')
})

test('a probe that answers nothing falls through to the next one', async () => {
  const path = await computeCliPathAsync(['true', 'echo /second/bin'], 2_000)
  expect(path.split(':')).toContain('/second/bin')
})
