import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '@solus/server/git/exec'
import type { CheckoutChange } from '@solus/contracts/checkout'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let CheckoutService: typeof import('@solus/server/git/checkout-service')['CheckoutService']
const directory = mkdtempSync(join(tmpdir(), 'solus-checkout-service-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = join(directory, 'data')
  ;({ CheckoutService } = await import('@solus/server/git/checkout-service'))
  git(['init', '-b', 'main'], directory)
  git(['config', 'user.name', 'Test'], directory)
  git(['config', 'user.email', 'test@example.invalid'], directory)
  git(['commit', '--allow-empty', '-m', 'Initial'], directory)
})
afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

test('creation, naming, shared attachments, external changes and restart use one identity', async () => {
  const service = new CheckoutService(() => false)
  const changes: CheckoutChange[] = []
  service.onChange((change) => changes.push(change))
  const restarted = new CheckoutService(() => false)
  try {
    const checkout = await service.create(directory, 'main')
    const cwd = checkout.worktreePath!
    const temporary = checkout.branch!
    const secondSession = service.attach(cwd, { ...checkout })
    expect(secondSession).toBe(checkout)
    await service.rename(cwd, temporary, 'Shared Rename')
    expect(secondSession.branch).toBe('solus/shared-rename')
    const renamed = changes.find((change) => change.cause === 'renamed')!
    expect(renamed.state.lastRename).toMatchObject({ previousBranch: temporary, branch: 'solus/shared-rename' })
    expect(service.attach(cwd, { ...checkout, branch: temporary }).branch).toBe('solus/shared-rename')

    git(['checkout', '-b', 'agent-choice'], cwd)
    await service.refresh(cwd)
    expect(checkout.branch).toBe('agent-choice')
    expect(changes.at(-1)?.cause).toBe('observed')
    expect(changes.at(-1)?.state.lastRename).toEqual(renamed.state.lastRename)
    expect(await service.rename(cwd, temporary, 'Do Not Override')).toBeNull()

    git(['checkout', '--detach'], cwd)
    await service.refresh(cwd)
    expect(checkout.branch).toBeNull()
    expect(checkout.detachedHeadSha).toBeTruthy()
    git(['checkout', 'agent-choice'], cwd)
    await service.refresh(cwd)
    expect(checkout.detachedHeadSha).toBeUndefined()

    const snapshot = await restarted.snapshot([cwd])
    expect(snapshot.generation).not.toBe(service.generation)
    expect(snapshot.states[0].checkout?.branch).toBe('agent-choice')
    expect(snapshot.states[0].checkout?.repoRoot).toBe(realpathSync(directory))
    expect(snapshot.states[0].checkout?.worktreePath).toBe(cwd)
    expect(changes.filter((change) => change.cause === 'renamed')).toHaveLength(1)

    git(['worktree', 'remove', cwd], directory)
    await service.refresh(cwd)
    expect(service.get(cwd)?.checkout).toBeNull()
    expect(() => service.attach(cwd, checkout)).toThrow('no longer available')
  } finally {
    service.dispose()
    restarted.dispose()
  }
})

test('a status scan already in flight cannot undo a confirmed rename', async () => {
  const { computeGitState } = await import('@solus/server/git/git-helpers')
  let release!: () => void
  const service = new CheckoutService(() => false)
  try {
    const checkout = await service.create(directory, 'main')
    const cwd = checkout.worktreePath!
    const previousBranch = checkout.branch!
    let scanned!: () => void
    // The controlled reader captures a pre-rename scan before naming starts.
    const captured = new Promise<void>((resolve) => { scanned = resolve })
    const staleStatus = await computeGitState(cwd)
    let first = true
    const racing = new CheckoutService(() => false, async (path) => {
      if (!first) return computeGitState(path)
      first = false
      scanned()
      await new Promise<void>((resolve) => { release = resolve })
      return staleStatus
    })
    try {
      racing.attach(cwd, { ...checkout })
      const read = racing.refresh(cwd)
      await captured
      let renamed!: () => void
      const receipt = new Promise<void>((resolve) => { renamed = resolve })
      const observed: CheckoutChange[] = []
      racing.onChange((change) => {
        observed.push(change)
        if (change.cause === 'renamed') renamed()
      })
      const rename = racing.rename(cwd, previousBranch, 'Fresh Identity')
      await receipt
      release()
      await Promise.all([read, rename])
      expect(racing.get(cwd)?.checkout?.branch).toBe('solus/fresh-identity')
      expect(observed.every((change) => change.state.checkout?.branch === 'solus/fresh-identity')).toBe(true)
    } finally { racing.dispose() }
  } finally { service.dispose() }
})
