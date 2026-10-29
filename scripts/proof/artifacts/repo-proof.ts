import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ArtifactsCloud } from './cloud'
import { command, diskBytes, git, initBare, pushRefs, ProofReport, type GitRemote } from './process'

interface DiskSample { phase: string; totalBytes: number; gitBytes: number; dependenciesBytes: number; outputBytes: number; elapsedMs?: number }
interface RepoLane { name: string; samples: DiskSample[]; cloneMs: number; statusMs?: number; filterAccepted: boolean }

export async function createRepositoryFixture(root: string): Promise<{ source: string; remote: GitRemote; head: string; baseline: string }> {
  const source = join(root, 'source')
  await mkdir(join(source, 'src'), { recursive: true })
  await mkdir(join(source, 'assets'))
  await git(source, ['init', '--initial-branch=main'])
  await writeFile(join(source, '.gitignore'), 'node_modules/\ndist/\n.env.local\n')
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'solus-proof-fixture', private: true, type: 'module', scripts: { test: 'node --test test.js' }, dependencies: { 'is-number': '7.0.0' } }))
  await writeFile(join(source, 'src/math.js'), 'export const sum = (a, b) => a + b\n')
  await writeFile(join(source, 'test.js'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { sum } from './src/math.js'\ntest('adding a negative value reduces the total', () => assert.equal(sum(5, -2), 3))\n")
  await writeFile(join(source, 'run.sh'), '#!/bin/sh\nnode --test test.js\n')
  await chmod(join(source, 'run.sh'), 0o755)
  await symlink('src/math.js', join(source, 'math-link'))
  for (let index = 0; index < 100; index++) await writeFile(join(source, `src/module-${index}.js`), `export const label = 'module ${index}'\n${'// source fixture\n'.repeat(200)}`)
  await writeFile(join(source, 'settings.txt'), 'base\n')
  await git(source, ['add', '.'])
  await git(source, ['commit', '-m', 'baseline'])
  const baseline = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(source, ['tag', 'v1.0.0'])
  // Obsolete binary versions expose whether the server really accepts blob filtering.
  for (let index = 0; index < 8; index++) {
    await writeFile(join(source, 'assets/history.bin'), randomBytes(2 * 1024 * 1024))
    await git(source, ['add', 'assets/history.bin'])
    await git(source, ['commit', '-m', `historical binary ${index}`])
  }
  for (let index = 0; index < 6; index++) await writeFile(join(source, `assets/current-${index}.bin`), randomBytes(1024 * 1024))
  await git(source, ['add', 'assets'])
  await git(source, ['commit', '-m', 'current assets'])
  await git(source, ['switch', '-c', 'feature'])
  await writeFile(join(source, 'feature.txt'), 'feature branch\n')
  await git(source, ['add', 'feature.txt'])
  await git(source, ['commit', '-m', 'feature'])
  await git(source, ['switch', 'main'])
  await git(source, ['merge', '--no-ff', 'feature', '-m', 'merge feature'])
  await git(source, ['branch', 'conflict-a'])
  await git(source, ['branch', 'conflict-b'])
  const head = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim()
  const remote = await initBare(join(root, 'upstream.git'))
  await git(source, ['remote', 'add', 'origin', remote.url])
  await git(source, ['push', '--all', 'origin'])
  await git(source, ['push', '--tags', 'origin'])
  return { source, remote, head, baseline }
}

async function sample(path: string, phase: string, elapsedMs?: number): Promise<DiskSample> {
  const size = async (name: string) => diskBytes(join(path, name)).catch(() => 0)
  return { phase, totalBytes: await diskBytes(path), gitBytes: await size('.git'), dependenciesBytes: await size('node_modules'), outputBytes: await size('dist'), elapsedMs }
}

export async function prepareDependencies(path: string): Promise<void> {
  await command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path })
  // Explicit synthetic disk load, reported separately from the one real npm dependency.
  await mkdir(join(path, 'node_modules/proof-load'), { recursive: true })
  for (let index = 0; index < 16; index++) await writeFile(join(path, `node_modules/proof-load/${index}.bin`), randomBytes(1024 * 1024))
  await mkdir(join(path, 'dist'), { recursive: true })
  for (let index = 0; index < 8; index++) await writeFile(join(path, `dist/${index}.bin`), randomBytes(1024 * 1024))
}

async function runLane(root: string, name: string, remote: GitRemote, fixture: { head: string; baseline: string }, report: ProofReport): Promise<RepoLane> {
  const path = join(root, name)
  const clone = await git(root, ['clone', '--filter=blob:none', remote.url, path], { remote })
  const lane: RepoLane = { name, cloneMs: clone.elapsedMs, samples: [await sample(path, 'clone')], filterAccepted: !/filtering not recognized|does not support filter/i.test(clone.stderr) }
  await report.check(`${name}: selected commit, complete ancestry, branches and tags`, async () => {
    assert.equal((await git(path, ['rev-parse', 'HEAD'])).stdout.trim(), fixture.head)
    assert.equal((await git(path, ['rev-parse', '--is-shallow-repository'])).stdout.trim(), 'false')
    assert.equal((await git(path, ['merge-base', 'HEAD', 'v1.0.0'])).stdout.trim(), fixture.baseline)
    assert.ok((await git(path, ['branch', '-r'])).stdout.includes('origin/feature'))
    assert.equal((await git(path, ['rev-list', '--parents', '-n', '1', 'HEAD'])).stdout.trim().split(' ').length, 3)
    assert.equal(await readlink(join(path, 'math-link')), 'src/math.js')
    assert.equal((await command('sh', ['./run.sh'], { cwd: path })).code, 0)
  })
  await report.check(`${name}: search, dependency installation and tests`, async () => {
    const search = await git(path, ['grep', 'module 42', '--', 'src'])
    assert.ok(search.stdout.includes('module-42.js'))
    await prepareDependencies(path)
    await command('npm', ['test'], { cwd: path })
  })
  lane.samples.push(await sample(path, 'dependencies-and-tests'))
  await report.check(`${name}: linked worktree and an isolated commit`, async () => {
    const sibling = join(root, `${name}-linked`)
    await git(path, ['worktree', 'add', '-b', `${name}-agent`, sibling, 'HEAD'])
    await writeFile(join(sibling, 'agent.txt'), 'agent work\n')
    await git(sibling, ['add', 'agent.txt'])
    await git(sibling, ['commit', '-m', 'isolated agent change'])
    assert.equal((await git(path, ['rev-parse', 'HEAD'])).stdout.trim(), fixture.head)
    assert.equal((await git(sibling, ['show', 'HEAD:agent.txt'])).stdout, 'agent work\n')
    // Keep linked worktree metadata consistent with its owned disposable directory.
    await git(path, ['worktree', 'remove', sibling])
  })
  await report.check(`${name}: checkpoint restores staged, unstaged, untracked and ignored state`, async () => {
    await writeFile(join(path, 'src/math.js'), 'export const sum = (a, b) => a + b + 1\n')
    await git(path, ['add', 'src/math.js'])
    await writeFile(join(path, 'src/math.js'), 'export const sum = (a, b) => a + b + 2\n')
    await writeFile(join(path, 'untracked.txt'), 'unfinished work\n')
    await writeFile(join(path, '.env.local'), 'SYNTHETIC_SETTING=fixture-only\n')
    const status = await git(path, ['status', '--porcelain=v1', '--untracked-files=all'])
    lane.statusMs = status.elapsedMs
    const staged = (await git(path, ['diff', '--cached', '--binary'])).stdout
    const unstaged = (await git(path, ['diff', '--binary'])).stdout
    const archive = join(root, `${name}.tar`)
    await command('tar', ['-cf', archive, '-C', path, '.'])
    const restored = join(root, `${name}-restored`)
    await mkdir(restored)
    await command('tar', ['-xf', archive, '-C', restored])
    assert.equal((await git(restored, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout, status.stdout)
    assert.equal((await git(restored, ['diff', '--cached', '--binary'])).stdout, staged)
    assert.equal((await git(restored, ['diff', '--binary'])).stdout, unstaged)
    assert.equal(await readFile(join(restored, 'untracked.txt'), 'utf8'), 'unfinished work\n')
    assert.equal(await readFile(join(restored, '.env.local'), 'utf8'), 'SYNTHETIC_SETTING=fixture-only\n')
    assert.equal(await diskBytes(join(restored, 'node_modules')), await diskBytes(join(path, 'node_modules')))
  })
  lane.samples.push(await sample(path, 'dirty-checkpoint'))
  return lane
}

export async function repoProof(outdir: string, useCloud = false): Promise<void> {
  await mkdir(outdir, { recursive: true })
  const root = await mkdtemp(join(tmpdir(), 'solus-artifacts-repos-'))
  const report = new ProofReport()
  const lanes: RepoLane[] = []
  let cloud: ArtifactsCloud | null = null
  let cleanupErrors: string[] = []
  try {
    const fixture = await createRepositoryFixture(root)
    lanes.push(await runLane(root, 'partial-upstream', fixture.remote, fixture, report))
    await report.check('upstream refuses a stale push and preserves the accepted commit', async () => {
      const first = join(root, 'writer-a')
      const second = join(root, 'writer-b')
      for (const path of [first, second]) {
        await git(root, ['clone', '--filter=blob:none', fixture.remote.url, path])
        await writeFile(join(path, 'writer.txt'), path.endsWith('a') ? 'A\n' : 'B\n')
        await git(path, ['add', 'writer.txt'])
        await git(path, ['commit', '-m', 'concurrent writer'])
      }
      await git(first, ['push', 'origin', 'main'])
      assert.notEqual((await git(second, ['push', 'origin', 'main'], { allowFailure: true })).code, 0)
      await git(second, ['fetch', 'origin'])
      assert.equal((await git(second, ['show', 'origin/main:writer.txt'])).stdout, 'A\n')
      await git(second, ['rebase', 'origin/main'], { allowFailure: true })
      assert.ok((await git(second, ['ls-files', '-u'])).stdout.includes('writer.txt'))
    })
    if (useCloud) {
      cloud = await ArtifactsCloud.fromWrangler(process.env.CLOUDFLARE_ACCOUNT_ID ?? '', `solus-proof-${Date.now().toString(36)}`)
      const remote = await cloud.create('repository')
      await pushRefs(fixture.source, remote, 'heads')
      await pushRefs(fixture.source, remote, 'tags')
      lanes.push(await runLane(root, 'partial-artifacts', remote, fixture, report))
      await report.check('Artifacts HTTP reads the selected commit without a checkout', async () => {
        assert.equal(await cloud!.readFile(remote.name, fixture.head, 'src/math.js'), 'export const sum = (a, b) => a + b\n')
      })
      await report.check('read token cannot push to an Artifacts repository', async () => {
        const readRemote: GitRemote = { url: remote.url, token: await cloud!.issueToken(remote.name, 'read') }
        const path = join(root, 'read-token')
        await git(root, ['clone', '--filter=blob:none', remote.url, path], { remote: readRemote })
        await writeFile(join(path, 'forbidden.txt'), 'must not push')
        await git(path, ['add', 'forbidden.txt'])
        await git(path, ['commit', '-m', 'read token attempt'])
        assert.notEqual((await git(path, ['push', 'origin', 'main'], { remote: readRemote, allowFailure: true })).code, 0)
      })
    } else report.blocked('real Artifacts repository', 'Run with --cloud and Artifacts credentials')
    report.blocked('ArtifactFS lane', 'Run fuse-proof.ts on a Linux host with the pinned ArtifactFS binary')
    report.blocked('managed-host R2/snapshot recovery', 'This runner checks tar recovery; the existing host controller must be exercised separately')
    report.blocked('Claude/Codex execution and client verification', 'No product adapter has been installed; provider and UI lanes cannot validate it yet')
  } finally {
    cleanupErrors = await cloud?.cleanup() ?? []
    await writeFile(join(outdir, useCloud ? 'repositories-cloud.json' : 'repositories-local.json'), JSON.stringify({ checks: report.checks, lanes, cleanupErrors, fixture: 'synthetic: 16 MiB obsolete blobs, 8 MiB current assets, 100 source modules, one npm dependency, 16 MiB synthetic dependencies, 8 MiB synthetic output', operations: cloud?.operations ?? 0 }, null, 2))
    await rm(root, { recursive: true, force: true })
  }
  if (report.checks.some(check => check.status === 'fail') || cleanupErrors.length) throw new Error('Repository proof failed; read the result JSON')
}

if (import.meta.main) await repoProof(resolve(process.argv[2] ?? '.solus-local/artifacts-proof/results'), process.argv.includes('--cloud'))
