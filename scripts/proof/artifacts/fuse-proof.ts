import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { command, diskBytes, git, gitEnv, pushRefs, ProofReport, type GitRemote } from './process'
import { createRepositoryFixture, prepareDependencies } from './repo-proof'

interface FuseSample { phase: string; baselineBytes: number; artifactFsBytes: number; hydration: string }

async function mounted(path: string, daemon: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error(`ArtifactFS daemon exited (${daemon.exitCode})`)
    const stats = await statfs(path).catch(() => null)
    if (stats?.type === 0x65735546) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('FUSE mount did not become ready')
}

export async function fuseProof(binary: string, outdir: string, cloudRemote?: GitRemote): Promise<void> {
  await mkdir(outdir, { recursive: true })
  const root = await mkdtemp(join(tmpdir(), 'solus-artifacts-fuse-'))
  const state = join(root, 'state')
  const mountRoot = join(root, 'mounts')
  const baseline = join(root, 'baseline')
  const mount = join(mountRoot, 'project')
  const report = new ProofReport()
  const samples: FuseSample[] = []
  const timings: Array<{ operation: string; baselineMs?: number; artifactFsMs: number }> = []
  const env = { ...gitEnv(cloudRemote), ARTIFACT_FS_ROOT: state }
  let defaultTagPresent = false
  let daemon: ChildProcess | null = null
  let logFd: number | null = null
  try {
    const fixture = await createRepositoryFixture(root)
    const remote = cloudRemote ?? fixture.remote
    if (cloudRemote) {
      await pushRefs(fixture.source, remote, 'heads')
      await pushRefs(fixture.source, remote, 'tags')
    }
    const clone = await git(root, ['clone', '--filter=blob:none', remote.url, baseline], { remote })
    await mkdir(mountRoot)
    const added = await command(binary, ['add-repo', '--name', 'project', '--remote', remote.url, '--ref', 'refs/heads/main', '--refresh', 'never', '--mount-root', mountRoot], { env })
    timings.push({ operation: 'prepare', baselineMs: clone.elapsedMs, artifactFsMs: added.elapsedMs })
    logFd = openSync(join(root, 'daemon.log'), 'w')
    daemon = spawn(binary, ['daemon', '--root', mountRoot], { env: { ...process.env, ...env }, stdio: ['ignore', logFd, logFd] })
    await mounted(mount, daemon)
    const takeSample = async (phase: string) => {
      const hydration = (await command(binary, ['status', '--name', 'project'], { env })).stdout.trim()
      samples.push({ phase, baselineBytes: await diskBytes(baseline), artifactFsBytes: await diskBytes(state), hydration })
    }
    await takeSample('mount-ready')
    defaultTagPresent = (await git(mount, ['rev-parse', '--verify', 'v1.0.0'], { allowFailure: true })).code === 0
    // Solus requires all branches and tags. ArtifactFS's default acquisition selects one ref.
    await git(mount, ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*', '--tags'], { remote })
    await report.check('FUSE: selected commit, full history, tags, executable files and source reads', async () => {
      assert.equal((await git(mount, ['rev-parse', 'HEAD'])).stdout.trim(), fixture.head)
      assert.equal((await git(mount, ['rev-parse', '--is-shallow-repository'])).stdout.trim(), 'false')
      assert.equal((await git(mount, ['merge-base', 'HEAD', 'v1.0.0'])).stdout.trim(), fixture.baseline)
      assert.equal(await readFile(join(mount, 'src/math.js'), 'utf8'), 'export const sum = (a, b) => a + b\n')
      await command('sh', ['./run.sh'], { cwd: mount })
    })
    await report.check('FUSE: Git status and file search', async () => {
      const status = await git(mount, ['status', '--porcelain=v1'])
      const normal = await git(baseline, ['status', '--porcelain=v1'])
      assert.equal(status.stdout, normal.stdout)
      timings.push({ operation: 'status-clean', baselineMs: normal.elapsedMs, artifactFsMs: status.elapsedMs })
      const search = await git(mount, ['grep', 'module 42', '--', 'src'])
      assert.ok(search.stdout.includes('module-42.js'))
      timings.push({ operation: 'source-search', artifactFsMs: search.elapsedMs })
    })
    await takeSample('source-search-and-tests')
    await report.check('FUSE: dependencies and generated files remain usable', async () => {
      await prepareDependencies(baseline)
      await prepareDependencies(mount)
      await command('npm', ['test'], { cwd: mount })
      assert.equal((await git(mount, ['status', '--porcelain=v1'])).stdout, (await git(baseline, ['status', '--porcelain=v1'])).stdout)
    })
    await takeSample('dependencies-and-output')
    await report.check('FUSE: commit a rename, deletion and new file, then read the committed tree', async () => {
      await git(mount, ['mv', 'settings.txt', 'renamed-settings.txt'])
      await git(mount, ['rm', 'src/module-0.js'])
      await writeFile(join(mount, 'new.txt'), 'new content\n')
      await git(mount, ['add', 'new.txt'])
      const committed = await git(mount, ['commit', '-m', 'FUSE edit'])
      timings.push({ operation: 'commit', artifactFsMs: committed.elapsedMs })
      assert.equal((await git(mount, ['show', 'HEAD:new.txt'])).stdout, 'new content\n')
      assert.equal((await git(mount, ['show', 'HEAD:renamed-settings.txt'])).stdout, 'base\n')
      await git(mount, ['push', 'origin', 'main'], { remote })
    })
    await report.check('FUSE: linked worktree supports an independent branch', async () => {
      const linked = join(root, 'linked')
      await git(mount, ['worktree', 'add', '-b', 'agent-work', linked, 'HEAD'])
      await writeFile(join(linked, 'agent.txt'), 'separate agent\n')
      await git(linked, ['add', 'agent.txt'])
      await git(linked, ['commit', '-m', 'agent work'])
      assert.equal((await git(linked, ['show', 'HEAD:agent.txt'])).stdout, 'separate agent\n')
      await git(mount, ['worktree', 'remove', linked])
    })
    await report.check('FUSE: dirty state survives daemon restart', async () => {
      await writeFile(join(mount, 'src/math.js'), 'export const sum = (a, b) => a + b + 1\n')
      await git(mount, ['add', 'src/math.js'])
      await writeFile(join(mount, 'src/math.js'), 'export const sum = (a, b) => a + b + 2\n')
      await writeFile(join(mount, 'untracked.txt'), 'unfinished\n')
      await writeFile(join(mount, '.env.local'), 'SYNTHETIC_SETTING=fixture-only\n')
      const staged = (await git(mount, ['diff', '--cached', '--binary'])).stdout
      const unstaged = (await git(mount, ['diff', '--binary'])).stdout
      const status = (await git(mount, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout
      const stopped = new Promise<void>(resolve => daemon!.once('close', () => resolve()))
      daemon!.kill('SIGTERM')
      await stopped
      daemon = spawn(binary, ['daemon', '--root', mountRoot], { env: { ...process.env, ...env }, stdio: ['ignore', logFd!, logFd!] })
      await mounted(mount, daemon)
      assert.equal((await git(mount, ['diff', '--cached', '--binary'])).stdout, staged)
      assert.equal((await git(mount, ['diff', '--binary'])).stdout, unstaged)
      assert.equal((await git(mount, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout, status)
      assert.equal(await readFile(join(mount, '.env.local'), 'utf8'), 'SYNTHETIC_SETTING=fixture-only\n')
      assert.equal(await readFile(join(mount, 'untracked.txt'), 'utf8'), 'unfinished\n')
    })
    await takeSample('edited-and-restarted')
  } finally {
    if (daemon && daemon.exitCode === null) {
      const stopped = new Promise<void>(resolve => daemon!.once('close', () => resolve()))
      daemon.kill('SIGTERM')
      await stopped
    }
    if (logFd !== null) closeSync(logFd)
    const log = await readFile(join(root, 'daemon.log'), 'utf8').catch(() => '')
    await writeFile(join(outdir, 'fuse.json'), JSON.stringify({ artifactFsCommit: '2b87a48691ef4ae82d391b7bbe4976c06c7fadf7', checks: report.checks, samples, timings, defaultTagPresent, transport: cloudRemote ? 'real Artifacts HTTPS Git remote' : 'file:// synthetic bare upstream; not the Artifacts service', daemonLog: log }, null, 2))
    await rm(root, { recursive: true, force: true })
  }
  if (report.checks.some(check => check.status === 'fail')) throw new Error('FUSE proof failed; read fuse.json')
}

if (import.meta.main) {
  const remote = process.argv.includes('--remote-stdin') ? z.object({ url: z.string().url(), token: z.string().optional() }).parse(JSON.parse(await readFile('/dev/stdin', 'utf8'))) : undefined
  await fuseProof(resolve(process.argv[2] ?? '/tmp/solus-proof-artifact-fs-2b87a48'), resolve(process.argv[3] ?? './fuse-results'), remote)
}
