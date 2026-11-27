import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useMemberSwitch } from '@solus/server/cli-env'
import { defaultSpawn, stopChild } from '@solus/server/execution/agents/acp/acp-process'

const roots: string[] = []
afterEach(() => {
  useMemberSwitch(null)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The member switch is POSIX only, as are process groups.
test.skipIf(process.platform === 'win32')('a member’s agent is stopped as that member, through the member switch', async () => {
  // WHY: on a host where each member is a Linux user, the server may not signal a
  // member's agy (EPERM). Its Stop, its idle close, and the host's shutdown then left
  // agy running, and the supervisor refused the checkpoint (Cloudflare proof run 8).
  const root = mkdtempSync(join(tmpdir(), 'acp-member-stop-'))
  roots.push(root)
  const calls = join(root, 'calls.txt')
  // Stands in for `solus-switch <uid> -- <command>`: it records the call and runs the command as this user.
  const memberSwitch = join(root, 'solus-switch')
  writeFileSync(memberSwitch, `#!/bin/sh\necho "$*" >> '${calls}'\nshift 2\nexec "$@"\n`)
  chmodSync(memberSwitch, 0o755)
  useMemberSwitch(memberSwitch)

  const child = defaultSpawn(memberSwitch, ['20000', '--', 'sleep', '30'], { cwd: root, env: { PATH: process.env.PATH } })
  // The stand-in switch has run once it wrote its call; then `sleep` is running as the member.
  for (let tries = 0; !existsSync(calls) && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 50))
  await new Promise((resolve) => setTimeout(resolve, 100))
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)))
  stopChild(child)

  expect(await exited).toBe('SIGTERM')
  expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['20000 -- sleep 30', `20000 -- kill -TERM -- -${child.pid}`])
})
