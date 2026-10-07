import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { computeCliPathAsync, importLoginShellEnv, loginShellEnvToImport } from '@solus/server/cli-env'

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

test('the PATH probe reads the login shell PATH, not the PATH Solus was launched with', () => {
  // WHY: a Dock launch has only a minimal PATH, and the probe exists to find the
  // tools a profile adds. Double-quoted under `/bin/sh -c`, `$PATH` expanded to
  // the launch PATH before zsh started, so the probe echoed back what it had.
  const node = Bun.which('node')
  if (!node) throw new Error('This test requires Node.js.')
  const home = mkdtempSync(join(tmpdir(), 'solus-path-probe-'))
  writeFileSync(join(home, '.zshenv'), 'export PATH=/probe/login:$PATH\n')
  const moduleUrl = new URL('../../packages/server/src/cli-env.ts', import.meta.url).href
  const script = `const { computeCliPathAsync } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(await computeCliPathAsync())`
  const result = Bun.spawnSync([node, '--input-type=module', '-e', script], {
    env: { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: home, ZDOTDIR: home },
  })
  expect(result.stdout.toString().split(':')).toContain('/probe/login')
})

test('a probe that answers nothing falls through to the next one', async () => {
  const path = await computeCliPathAsync(['true', 'echo /second/bin'], 2_000)
  expect(path.split(':')).toContain('/second/bin')
})

function envProbeOutput(...entries: string[]): string {
  return ['profile banner\n', '__SOLUS_LOGIN_ENV_START__', ...entries, '__SOLUS_LOGIN_ENV_END__', ''].join('\0')
}

test('a Dock launch takes Solus and tool variables from the login shell, but no provider keys', () => {
  // WHY: launched from the Dock, the app has none of the user's profile, so an
  // exported SOLUS_DATA_DIR silently fell back to ~/.solus. Provider API keys
  // stay out: importing one would change which account an agent bills.
  const imported = loginShellEnvToImport(envProbeOutput(
    'SOLUS_DATA_DIR=/data/solus',
    'SSH_AUTH_SOCK=/tmp/agent.sock',
    'OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318',
    'CODEX_HOME=/codex',
    'ANTHROPIC_API_KEY=secret',
    'OPENAI_API_KEY=secret',
    'HOME=/elsewhere',
  ), {})
  expect([...imported]).toEqual([
    ['SOLUS_DATA_DIR', '/data/solus'],
    ['SSH_AUTH_SOCK', '/tmp/agent.sock'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector:4318'],
    ['CODEX_HOME', '/codex'],
  ])
})

test('a variable the app was launched with wins over the login shell, even when empty', () => {
  const imported = loginShellEnvToImport(envProbeOutput('SOLUS_DATA_DIR=/profile', 'SOLUS_PORT=4000'), { SOLUS_DATA_DIR: '/launch', SOLUS_PORT: '' })
  expect(imported.size).toBe(0)
})

test('profile noise and multiline values do not corrupt the environment', () => {
  // WHY: interactive profiles print banners, and `SOLUS_X=a=b` or a value with
  // newlines must come through whole rather than split into fake variables.
  const output = 'SOLUS_FAKE=from-banner\n' + envProbeOutput('SOLUS_NOTE=line one\nSOLUS_INJECTED=no', 'SOLUS_PAIR=a=b')
  expect([...loginShellEnvToImport(output, {})]).toEqual([
    ['SOLUS_NOTE', 'line one\nSOLUS_INJECTED=no'],
    ['SOLUS_PAIR', 'a=b'],
  ])
  expect(loginShellEnvToImport('SOLUS_DATA_DIR=/x\n', {}).size).toBe(0)
})

test('importing the login shell environment sets only what is missing in process.env', async () => {
  const names = ['SOLUS_LOGIN_ENV_TEST_NEW', 'SOLUS_LOGIN_ENV_TEST_SET']
  process.env.SOLUS_LOGIN_ENV_TEST_SET = 'launch'
  try {
    const output = envProbeOutput('SOLUS_LOGIN_ENV_TEST_NEW=profile', 'SOLUS_LOGIN_ENV_TEST_SET=profile')
    const command = `printf '${output.replaceAll('\0', '\\0').replaceAll('\n', '\\n')}'`
    expect(await importLoginShellEnv(['true', command], 2_000)).toEqual(['SOLUS_LOGIN_ENV_TEST_NEW'])
    expect(process.env.SOLUS_LOGIN_ENV_TEST_NEW).toBe('profile')
    expect(process.env.SOLUS_LOGIN_ENV_TEST_SET).toBe('launch')
  } finally {
    for (const name of names) delete process.env[name]
  }
})
