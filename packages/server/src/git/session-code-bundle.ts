import { rm, stat } from 'fs/promises'
import type { TurnSnapshot } from '@solus/contracts/types'
import { runAsync } from './exec'

/**
 * The code state of a session's turns as a Git bundle
 * (docs/plans/portable-sessions.md §4 decisions 9 and 10).
 *
 * A bundle holds only the objects that the project's origin does not have and
 * that an earlier bundle of the session did not carry: the turn-start and
 * turn-end snapshots and the commits of the branch that were not pushed. The
 * project history comes from origin through each host's own clone.
 *
 * A bundle of a ref that points at a tree holds the full tree, so each snapshot
 * travels as a commit whose parent is in known history. The turn-end snapshot
 * is a commit already (`session-snapshots.ts`); the turn-start tree is wrapped
 * here.
 */

/** A larger bundle is not written: a file that Git does not ignore made it so. */
export const CODE_BUNDLE_MAX_BYTES = 200 * 1024 * 1024
const BUNDLE_TIMEOUT_MS = 10 * 60_000

const WRAP_AUTHOR_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Solus Snapshot',
  GIT_AUTHOR_EMAIL: 'snapshot@solus.local',
  GIT_COMMITTER_NAME: 'Solus Snapshot',
  GIT_COMMITTER_EMAIL: 'snapshot@solus.local',
}

export interface TurnCodeState {
  sessionId: string
  /** The snapshots this bundle covers, in order. */
  snapshots: TurnSnapshot[]
  /** The commit before the first of them: the session base, or the snapshot commit before it. */
  previousCommit: string
  /** The branch tip when the turn ended; null on a branch with no commit. */
  headSha: string | null
  /** Commits that an earlier bundle of this session carried. */
  carried: string[]
}

export type TurnCodeBundle =
  /** `refs` are the refs in the bundle, by name. */
  | { kind: 'written'; refs: Record<string, string>; bytes: number }
  /** Origin and the earlier bundles already hold every object. */
  | { kind: 'empty' }
  | { kind: 'too-large'; bytes: number }

/** The ref a bundle names a carried commit by. A host that fetches a bundle reads these. */
export function bundleRef(sessionId: string, name: string): string {
  return `refs/solus/sessions/${sessionId}/bundle/${name}`
}

async function treeOf(repoRoot: string, commit: string): Promise<string> {
  return runAsync('git', ['rev-parse', `${commit}^{tree}`], repoRoot)
}

/**
 * Write the bundle of `state` to `outFile`. The bundle refs exist in the project
 * only while Git reads them; the snapshot refs keep the objects.
 */
export async function writeTurnCodeBundle(repoRoot: string, state: TurnCodeState, outFile: string): Promise<TurnCodeBundle> {
  const refs = new Map<string, string>()
  let previous = state.previousCommit
  for (const snapshot of state.snapshots) {
    if (snapshot.fromTreeSha !== await treeOf(repoRoot, previous)) {
      const date = `@${Math.floor(snapshot.timestamp / 1000)} +0000`
      refs.set(bundleRef(state.sessionId, `${snapshot.index}/from`), await runAsync('git', [
        'commit-tree', snapshot.fromTreeSha, '-p', previous, '-m', `solus-snapshot sid=${state.sessionId} turn=${snapshot.index} start`,
      ], repoRoot, { env: { ...WRAP_AUTHOR_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }))
    }
    refs.set(bundleRef(state.sessionId, `${snapshot.index}/to`), snapshot.sha)
    previous = snapshot.sha
  }
  if (state.headSha) refs.set(bundleRef(state.sessionId, 'head'), state.headSha)
  if (!refs.size) return { kind: 'empty' }

  try {
    for (const [ref, sha] of refs) await runAsync('git', ['update-ref', ref, sha], repoRoot)
    try {
      await runAsync('git', ['bundle', 'create', outFile, ...refs.keys(), '--not', '--remotes=origin', ...state.carried], repoRoot, { timeout: BUNDLE_TIMEOUT_MS })
    } catch (error) {
      // Git refuses a bundle with no object: every ref is in known history.
      if (error instanceof Error && /empty bundle/i.test(error.message)) return { kind: 'empty' }
      throw error
    }
    const { size } = await stat(outFile)
    if (size > CODE_BUNDLE_MAX_BYTES) {
      await rm(outFile, { force: true })
      return { kind: 'too-large', bytes: size }
    }
    const included: Record<string, string> = {}
    for (const line of (await runAsync('git', ['bundle', 'list-heads', outFile], repoRoot)).split('\n').filter(Boolean)) {
      const [sha, ref] = line.split(' ')
      if (sha && ref) included[ref] = sha
    }
    return { kind: 'written', refs: included, bytes: size }
  } finally {
    for (const ref of refs.keys()) await runAsync('git', ['update-ref', '-d', ref], repoRoot).catch(() => {})
  }
}

/**
 * Write the diff between two snapshot trees to `outFile`, with binary changes,
 * so a reader with no checkout can show the turn. False when the two are equal.
 */
export async function writeTurnDiffPatch(repoRoot: string, fromTree: string, toTree: string, outFile: string): Promise<boolean> {
  if (fromTree === toTree) return false
  await runAsync('git', ['-c', 'core.quotepath=false', 'diff', '--binary', `--output=${outFile}`, fromTree, toTree], repoRoot, { timeout: BUNDLE_TIMEOUT_MS })
  return true
}
