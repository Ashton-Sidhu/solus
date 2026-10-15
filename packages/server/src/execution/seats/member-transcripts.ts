import { execFile } from 'node:child_process'
import { launchedProcess, type LaunchOptions } from '../../cli-env'
import { createLogger } from '../../logger'

const log = createLogger('main', 'member-transcripts')

/**
 * After a member's turn, where each member is their own Linux user
 * (docs/plans/member-isolation.md §5.1). Sessions are the organization's, so a
 * host keeps one transcript folder that every member's `~/.claude/projects` and
 * `~/.codex/sessions` link to. The CLIs write each transcript `0600`; run as the
 * member, this gives the project group read and write to the transcripts they
 * wrote in this turn, so the server indexes them and the next member resumes
 * them. The server's watch sees the change; nothing else is asked of it.
 */
export async function shareTurnTranscripts(launch: LaunchOptions, since: number): Promise<void> {
  const run = launchedProcess({ ...launch, env: { ...launch.env, ELECTRON_RUN_AS_NODE: '1' } }, process.execPath, ['-e', SHARE_SCRIPT, String(since)])
  await new Promise<void>((resolve) => {
    execFile(run.file, run.args, { env: run.env, timeout: 30_000 }, (error, _stdout, stderr) => {
      if (error) log.warn('member_transcripts_share_failed', { error: stderr.trim().split('\n').pop() || error.message })
      resolve()
    })
  })
}

/**
 * Runs as the member: `node -e SHARE_SCRIPT <since ms>`. Only the owner can change
 * a mode, so it changes only what this member made: their folders, and their
 * transcripts written since the turn started.
 */
const SHARE_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const since = Number(process.argv[1]);
const uid = process.getuid();
const share = (target, stat, bits) => {
  if (stat.uid !== uid || (stat.mode & bits) === bits) return;
  try { fs.chmodSync(target, stat.mode | bits); } catch {}
};
const walk = (dir) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    let stat;
    try { stat = fs.statSync(target); } catch { continue; }
    if (entry.isDirectory()) {
      share(target, stat, 0o070);
      walk(target);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && stat.mtimeMs >= since) {
      share(target, stat, 0o060);
    }
  }
};
for (const root of [path.join(process.env.HOME, '.claude', 'projects'), path.join(process.env.HOME, '.codex', 'sessions')]) walk(root);
`
