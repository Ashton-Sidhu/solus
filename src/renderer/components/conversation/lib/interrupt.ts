import type { PermissionOption, PermissionRequest } from '../../../../shared/types'

/**
 * Interrupt cards reuse the card chassis and stay in neutral chrome;
 * findability comes from the kicker and the chip, which are the only tinted
 * things on the card. Hue carries urgency, not decoration.
 */
export type InterruptKicker = {
  /** One word above the title, naming the type. */
  label: string
  /** The title is a question the user can answer. */
  title: string
  /** The chip says why it stopped, not what it is. */
  chip: string
  tone: 'warning' | 'destructive'
}

/** Tools whose effects can reach outside the worktree and can't be undone by
 *  discarding the branch. */
const DESTRUCTIVE_COMMAND_RE = /\brm\s+-[a-z]*[rf]|\bgit\s+push\s+.*--force|\bdd\s+if=|\bmkfs\b|\bshutdown\b|\bkillall\b/i

function commandOf(permission: PermissionRequest): string {
  const input = permission.toolInput
  const command = input?.command
  return typeof command === 'string' ? command : ''
}

export function isDestructive(permission: PermissionRequest): boolean {
  return DESTRUCTIVE_COMMAND_RE.test(commandOf(permission))
}

export function permissionKicker(permission: PermissionRequest): InterruptKicker {
  if (isDestructive(permission)) {
    return {
      label: 'Destructive',
      title: 'Run an irreversible command?',
      chip: 'Destructive',
      tone: 'destructive',
    }
  }
  const tool = permission.toolTitle
  const title =
    tool === 'Bash' || tool === 'exec_command'
      ? 'Run a shell command?'
      : tool === 'Edit' || tool === 'Write'
        ? 'Write to the worktree?'
        : tool === 'WebFetch' || tool === 'WebSearch'
          ? 'Reach the network?'
          : `Use ${tool}?`
  return { label: 'Permission', title, chip: 'Not in allowlist', tone: 'warning' }
}

/** The command, verbatim and never truncated, plus what it runs against. */
export function permissionArgv(
  permission: PermissionRequest,
): { label: string; text: string } | null {
  const command = commandOf(permission)
  if (!command) return null
  const cwd = permission.toolInput?.cwd
  const label = typeof cwd === 'string' && cwd ? `bash · cwd ${cwd}` : 'bash'
  return { label, text: command }
}

/**
 * Escape hatch left, affirmative right, scope-broadening in the middle — one
 * step further from the pointer than "allow once". Never the reverse, on any
 * interrupt.
 */
/** `40s`, `4m 10s` — how long the session has been holding at this step. */
export function formatWaiting(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * §11 — an option label takes inline code and nothing else, and its consequence
 * line takes inline code and plain text. Splitting on backticks rather than
 * running the markdown parser is what enforces that: an option row is itself a
 * button, so a parser free to emit a link — or `CodeSpan`'s clickable file
 * token — would nest one interactive element inside another.
 */
export function inlineCodeParts(text: string): { text: string; code: boolean }[] {
  return text
    .split(/`([^`]+)`/g)
    .map((part, i) => ({ text: part, code: i % 2 === 1 }))
    .filter((part) => part.text !== '')
}

/**
 * §11 — "(Recommended)" is a note about an option, not part of its name, so it
 * prints as a muted suffix after the label instead of competing with it. Callers
 * append it to the label because that is all the tool schema gives them.
 */
const RECOMMENDED_RE = /[\s·—-]*\(recommended\)\s*$/i

export function optionLabelParts(label: string): { text: string; note: string } {
  const match = RECOMMENDED_RE.exec(label)
  if (!match) return { text: label, note: '' }
  return { text: label.slice(0, match.index).trim(), note: 'recommended' }
}

/** "2nd question" reads better than "question 2" in a meta line. */
export function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

export function permissionFooterOrder(options: PermissionOption[]): {
  escape: PermissionOption | null
  middle: PermissionOption[]
  affirmative: PermissionOption | null
} {
  const isDeny = (o: PermissionOption) =>
    o.kind === 'deny' || /\b(deny|no|reject|cancel)\b/i.test(o.label)
  const isBroadening = (o: PermissionOption) => /\b(always|all|session)\b/i.test(o.label)

  const escape = options.find(isDeny) ?? null
  const remaining = options.filter((o) => o !== escape)
  // The narrowest allow wins the affirmative slot; broadening steps back.
  const affirmative = remaining.find((o) => !isBroadening(o)) ?? remaining[remaining.length - 1] ?? null
  const middle = remaining.filter((o) => o !== affirmative)
  return { escape, middle, affirmative }
}
