import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GitRemote } from '../../packages/server/src/sync/git-storage/git-remote'
import { ArtifactsRepositoryProvider } from '../../packages/server/src/sync/git-storage/artifacts-repository-provider'
import { actAsHostForTests } from '../../packages/server/src/execution/seats/acting-identity'

actAsHostForTests()
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'solus-git-remote-test-'))
  roots.push(root)
  const local = join(root, 'local.git')
  const remote = join(root, 'remote.git')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', local])
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote])
  const run = (args: string[]) => execFileSync('git', ['--git-dir', local, ...args], { encoding: 'utf8' }).trim()
  const commit = (parent?: string) => {
    const blob = run(['hash-object', '-w', '--stdin'])
    const tree = execFileSync('git', ['--git-dir', local, 'mktree'], { input: `100644 blob ${blob}\tfile\n`, encoding: 'utf8' }).trim()
    return execFileSync('git', ['--git-dir', local, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `turn ${Math.random()}`], {
      encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    }).trim()
  }
  const url = pathToFileURL(remote).href
  return { root, local, remote, url, run, commit }
}

// WHY: A turn commit must reach the cloud ref from the existing bare copy.
test('accepted push from a bare repository', async () => {
  const f = fixture()
  const commit = f.commit()
  const client = await GitRemote.open({ gitDir: f.local, remote: f.url, timeoutMs: 10_000 })
  try {
    expect(await client.checkedPush(commit, null)).toEqual({ status: 'accepted', head: commit })
    expect(await client.remoteHead()).toBe(commit)
  } finally { await client.close() }
})

// WHY: A second host must not replace the first host's accepted history.
test('moved head from another copy is refused and unchanged', async () => {
  const f = fixture()
  const first = f.commit()
  f.run(['update-ref', 'refs/heads/main', first])
  const otherCopy = join(f.root, 'other.git')
  execFileSync('git', ['clone', '--bare', f.local, otherCopy], { stdio: 'ignore' })
  const competing = f.commit(first)
  const firstClient = await GitRemote.open({ gitDir: otherCopy, remote: f.url, timeoutMs: 10_000 })
  const secondClient = await GitRemote.open({ gitDir: f.local, remote: f.url, timeoutMs: 10_000 })
  try {
    expect((await firstClient.checkedPush(first, null)).status).toBe('accepted')
    expect(await secondClient.checkedPush(competing, null)).toEqual({ status: 'refused', head: first })
    expect(await secondClient.remoteHead()).toBe(first)
  } finally { await firstClient.close(); await secondClient.close() }
})

// WHY: A lost push response must not create another turn commit.
test('retry of an accepted commit succeeds without another commit', async () => {
  const f = fixture()
  const commit = f.commit()
  const client = await GitRemote.open({ gitDir: f.local, remote: f.url, timeoutMs: 10_000 })
  try {
    await client.checkedPush(commit, null)
    expect(await client.checkedPush(commit, null)).toEqual({ status: 'accepted', head: commit })
  } finally { await client.close() }
})

// WHY: A repository token must stay out of persistent config, arguments, and error text.
test('token stays in askpass and askpass checks the host', async () => {
  const f = fixture()
  const token = 'secret-test-token'
  const client = await GitRemote.open({ gitDir: f.local, remote: 'https://expected.example/repo', token, timeoutMs: 1_000 })
  try {
    const env = (client as unknown as { env: NodeJS.ProcessEnv }).env
    const script = readFileSync(env.GIT_ASKPASS!, 'utf8')
    expect(script).not.toContain(token)
    expect(execFileSync(env.GIT_ASKPASS!, ['Username for \'https://expected.example\':'], { env, encoding: 'utf8' }).trim()).toBe('x')
    expect(execFileSync(env.GIT_ASKPASS!, ['Password for \'https://x@expected.example\':'], { env, encoding: 'utf8' }).trim()).toBe(token)
    expect(() => execFileSync(env.GIT_ASKPASS!, ['Password for \'https://other.example\':'], { env, stdio: 'pipe' })).toThrow()
    expect((client as unknown as { options: { remote: string } }).options.remote).not.toContain(token)
    expect(f.run(['config', '--list'])).not.toContain(token)
    await expect(client.repository.git(['show', 'missing-object'])).rejects.not.toThrow(token)
  } finally { await client.close() }
})

// WHY: A stalled transfer must give a bounded failure that the caller can retry.
test('timeout is a failed result', async () => {
  const f = fixture()
  const client = await GitRemote.open({ gitDir: f.local, remote: f.url, timeoutMs: 1 })
  try { expect((await client.checkedPush(f.commit(), null)).status).toBe('failed') }
  finally { await client.close() }
})

// WHY: the sync card shows the words of a failed Git process. A process that
// Solus stops has no exit code of its own; the words must give the number 1,
// as before the shared layer, and the caller must get the reason as a type.
test('a stopped process reports the number 1 and its reason', async () => {
  const f = fixture()
  const commit = f.commit()
  const writer = await GitRemote.open({ gitDir: f.local, remote: f.url, timeoutMs: 10_000 })
  const reader = await GitRemote.open({ gitDir: f.local, remote: f.url, timeoutMs: 10_000, outputLimitBytes: 8 })
  try {
    await writer.checkedPush(commit, null)
    await expect(reader.remoteHead()).rejects.toMatchObject({ reason: 'output-limit', message: 'The Git ls-remote operation failed (1).' })
  } finally { await writer.close(); await reader.close() }
})

// WHY: Session storage needs the same scoped token route as works.
test('Cloudflare accepts session names and requests read scope', async () => {
  const calls: Array<{ url: string; body?: string }> = []
  const account = 'a'.repeat(32)
  const mockedFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: init?.body as string | undefined })
    return Response.json(calls.length === 1
      ? { success: true, result: { remote: `https://${account}.artifacts.cloudflare.net/repo` } }
      : { success: true, result: { plaintext: 'short-token' } })
  }
  const access = new ArtifactsRepositoryProvider(account, 'test', 'account-token', undefined, mockedFetch)
  expect(await access.remote(`session-${'b'.repeat(48)}`, 'read')).toEqual({ url: `https://${account}.artifacts.cloudflare.net/repo`, token: 'short-token' })
  expect(JSON.parse(calls[1]!.body!)).toMatchObject({ scope: 'read' })
  await expect(access.remote('session-bad', 'read')).rejects.toThrow('Invalid Solus repository name')
})

// WHY: works and sessions read their files through one Artifacts client. A
// person who reads a session from Solus Cloud must not get an error about a
// work body.
test('a failed Artifacts read names the repository file, not a feature', async () => {
  const failing: typeof fetch = async () => new Response('', { status: 500 })
  const access = new ArtifactsRepositoryProvider('a'.repeat(32), 'test', 'account-token', undefined, failing)
  await expect(access.readFile(`session-${'b'.repeat(48)}`, 'c'.repeat(40), 'manifest.json')).rejects.toThrow('The Artifacts repository file could not be read.')
})
