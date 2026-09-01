import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeSessionFilePath } from '@solus/server/agents/claude/claude-session-helpers'
import { encodePathAsFolder } from '@solus/contracts/types'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Claude session transcript paths', () => {
  test('uses the indexed worktree folder when a restored tab requests the project root', async () => {
    // WHY: Claude can move a running transcript into an agent worktree, but the
    // restored Solus tab can still name the root checkout. The indexed location
    // is the durable source of truth for that provider session.
    const projectsRoot = await mkdtemp(join(tmpdir(), 'solus-claude-projects-'))
    tempDirs.push(projectsRoot)
    const sessionId = 'session-in-worktree'
    const requestedProjectPath = '/repo'
    const indexedProjectPath = `${encodePathAsFolder(requestedProjectPath)}--claude-worktrees-task`
    const indexedDir = join(projectsRoot, indexedProjectPath)
    const transcriptPath = join(indexedDir, `${sessionId}.jsonl`)
    await mkdir(indexedDir, { recursive: true })
    await writeFile(transcriptPath, '{}\n')

    expect(resolveClaudeSessionFilePath(
      projectsRoot,
      sessionId,
      requestedProjectPath,
      () => indexedProjectPath,
    )).toBe(transcriptPath)
  })

  test('keeps the requested path when both requested and indexed copies exist', async () => {
    // WHY: an index update can lag an active write. The path supplied by the
    // current session must win while it still contains the transcript.
    const projectsRoot = await mkdtemp(join(tmpdir(), 'solus-claude-projects-'))
    tempDirs.push(projectsRoot)
    const sessionId = 'session-at-requested-path'
    const requestedProjectPath = '/repo'
    const requestedDir = join(projectsRoot, encodePathAsFolder(requestedProjectPath))
    const indexedDir = join(projectsRoot, '-stale-worktree')
    const requestedTranscript = join(requestedDir, `${sessionId}.jsonl`)
    await mkdir(requestedDir, { recursive: true })
    await mkdir(indexedDir, { recursive: true })
    await writeFile(requestedTranscript, '{}\n')
    await writeFile(join(indexedDir, `${sessionId}.jsonl`), '{}\n')
    let indexReads = 0

    expect(resolveClaudeSessionFilePath(
      projectsRoot,
      sessionId,
      requestedProjectPath,
      () => {
        indexReads++
        return '-stale-worktree'
      },
    )).toBe(requestedTranscript)
    expect(indexReads).toBe(0)
  })
})
