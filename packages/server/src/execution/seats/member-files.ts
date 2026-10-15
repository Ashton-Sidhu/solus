import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { launchedProcess, type ProcessUser } from '../../cli-env'

/**
 * Files Solus keeps in a member's folders: their `.gitconfig`, GitHub login, seat
 * token, and agent profile. On a host where each member is their own Linux user
 * (docs/plans/member-isolation.md §5) those folders are the member's, so the
 * server cannot write there: the change runs as the member, in one short process.
 * Elsewhere it runs here. Either way the same changes give the same files.
 */
export type MemberFileChange =
  /** Writes the file when its content differs, making its folders; sets its mode. */
  | { kind: 'write'; path: string; content: string | Buffer; mode: number }
  /** Removes a file or, with `recursive`, a folder; nothing there is not an error. */
  | { kind: 'remove'; path: string; recursive?: boolean }
  /** Removes a folder if it is empty. */
  | { kind: 'removeEmptyFolder'; path: string }
  /** Makes a folder and its parents, with exactly this mode. */
  | { kind: 'folder'; path: string; mode: number }

/**
 * As the member, a folder or file Solus makes is also readable by its group. The
 * member's folders are setgid `solus`, and only the server is in that group, so
 * the server reads back what it wrote (a seat token, the profile manifest) and no
 * other member can.
 */
const MEMBER_FOLDER_MODE = 0o750
const GROUP_READ = 0o040

export function applyMemberFiles(user: ProcessUser | null, changes: MemberFileChange[]): void {
  if (changes.length === 0) return
  if (!user) {
    applyHere(changes)
    return
  }
  const input = JSON.stringify(changes.map((change) => change.kind === 'write'
    ? { ...change, content: Buffer.from(change.content).toString('base64') }
    : change))
  // Only what the script needs: nothing of the server's environment reaches the member.
  const run = launchedProcess({ env: { ELECTRON_RUN_AS_NODE: '1' }, user }, process.execPath, ['-e', APPLY_SCRIPT])
  const result = spawnSync(run.file, run.args, {
    input,
    env: run.env,
    stdio: ['pipe', 'ignore', 'pipe'],
    timeout: 10_000,
  })
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString().trim().split('\n').pop() ?? `exit ${result.status}`
    throw new Error(`Could not write your files on this host: ${detail}`)
  }
}

function applyHere(changes: MemberFileChange[]): void {
  for (const change of changes) {
    if (change.kind === 'write') {
      if (sameContent(change.path, change.content)) {
        chmodSync(change.path, change.mode)
        continue
      }
      mkdirSync(dirname(change.path), { recursive: true, mode: 0o700 })
      writeFileSync(change.path, change.content, { mode: change.mode })
      // `mode` above applies only to a new file.
      chmodSync(change.path, change.mode)
    } else if (change.kind === 'remove') {
      rmSync(change.path, { force: true, recursive: change.recursive ?? false })
    } else if (change.kind === 'folder') {
      mkdirSync(change.path, { recursive: true, mode: change.mode })
    } else {
      try { rmdirSync(change.path) } catch { /* not empty, or gone */ }
    }
  }
}

function sameContent(path: string, content: string | Buffer): boolean {
  try {
    return readFileSync(path).equals(Buffer.from(content))
  } catch {
    return false
  }
}

/** `applyHere`, for a process that has nothing but Node: it reads the changes from stdin. */
const APPLY_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const changes = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const change of changes) {
  if (change.kind === 'write') {
    const content = Buffer.from(change.content, 'base64');
    let same = false;
    try { same = fs.readFileSync(change.path).equals(content); } catch {}
    const mode = change.mode | ${GROUP_READ};
    if (!same) {
      fs.mkdirSync(path.dirname(change.path), { recursive: true, mode: ${MEMBER_FOLDER_MODE} });
      fs.writeFileSync(change.path, content, { mode });
    }
    fs.chmodSync(change.path, mode);
  } else if (change.kind === 'remove') {
    fs.rmSync(change.path, { force: true, recursive: !!change.recursive });
  } else if (change.kind === 'folder') {
    fs.mkdirSync(change.path, { recursive: true, mode: change.mode });
    fs.chmodSync(change.path, change.mode);
  } else {
    try { fs.rmdirSync(change.path); } catch {}
  }
}
`
