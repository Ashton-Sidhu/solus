import type { Component } from 'svelte'

/** A single actionable entry in the command palette. */
export interface Command {
  /** Stable identifier (used as the Svelte keyed-each key). */
  id: string
  /** Primary text shown in the row. */
  label: string
  /** Section heading the command is grouped under. */
  group: string
  /** Optional extra terms that should match the search query. */
  keywords?: string[]
  /** Optional leading icon (@lucide/svelte component). */
  icon?: Component
  /** Optional trailing hint, e.g. a formatted shortcut like "⌘B". */
  hint?: string
  /**
   * If present, selecting this command drills into a sub-page listing these
   * commands instead of running an action. Lets a single root entry (e.g.
   * "Open worktree…") stand in for a long list without polluting the root view.
   */
  children?: Command[]
  /** Invoked when the command is selected. Optional for pure parent commands. */
  run?: () => void
}

export interface CommandGroup {
  title: string
  items: Command[]
}

export type CommandSelectionMove =
  | 'first'
  | 'last'
  | 'next'
  | 'previous'
  | 'next-group'
  | 'previous-group'

const searchTextCache = new WeakMap<Command, string>()

function commandSearchText(command: Command): string {
  const cached = searchTextCache.get(command)
  if (cached !== undefined) return cached

  const text = [
    command.label,
    command.group,
    ...(command.keywords ?? []),
  ].join('\n').toLowerCase()
  searchTextCache.set(command, text)
  return text
}

/** Case-insensitive substring match over label, group and keywords. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  return commands.filter((c) => commandSearchText(c).includes(q))
}

/** Group commands by their `group`, preserving first-seen order. */
export function groupCommands(commands: Command[]): CommandGroup[] {
  const map = new Map<string, Command[]>()
  for (const c of commands) {
    let arr = map.get(c.group)
    if (!arr) {
      arr = []
      map.set(c.group, arr)
    }
    arr.push(c)
  }
  return Array.from(map.entries()).map(([title, items]) => ({ title, items }))
}

/**
 * Keeps the user's selected command across live list updates. Falls back to the
 * first visible command only when the previous selection is no longer present.
 */
export function retainCommandSelection(
  commands: Command[],
  selectedCommandId: string,
): string {
  return commands.some((command) => command.id === selectedCommandId)
    ? selectedCommandId
    : commands[0]?.id ?? ''
}

/**
 * Resolves keyboard navigation from a stable command id, so inserting commands
 * into a live list does not turn the current selection into a stale index.
 */
export function moveCommandSelection(
  commands: Command[],
  selectedCommandId: string,
  move: CommandSelectionMove,
  loop = false,
): string {
  if (commands.length === 0) return ''

  const selectedIndex = commands.findIndex((command) => command.id === selectedCommandId)
  const currentIndex = selectedIndex >= 0 ? selectedIndex : 0

  if (move === 'first') return commands[0]!.id
  if (move === 'last') return commands.at(-1)!.id

  if (move === 'next' || move === 'previous') {
    const offset = move === 'next' ? 1 : -1
    const nextIndex = selectedIndex < 0 && move === 'next'
      ? 0
      : currentIndex + offset
    if (nextIndex >= 0 && nextIndex < commands.length) {
      return commands[nextIndex]!.id
    }
    if (!loop) return commands[currentIndex]!.id
    return move === 'next' ? commands[0]!.id : commands.at(-1)!.id
  }

  const direction = move === 'next-group' ? 1 : -1
  const currentGroup = commands[currentIndex]!.group
  let candidateIndex = currentIndex + direction
  while (
    candidateIndex >= 0 &&
    candidateIndex < commands.length &&
    commands[candidateIndex]!.group === currentGroup
  ) {
    candidateIndex += direction
  }

  if (candidateIndex < 0 || candidateIndex >= commands.length) {
    if (!loop) return commands[currentIndex]!.id
    candidateIndex = move === 'next-group' ? 0 : commands.length - 1
  }

  const targetGroup = commands[candidateIndex]!.group
  while (
    candidateIndex > 0 &&
    commands[candidateIndex - 1]!.group === targetGroup
  ) {
    candidateIndex -= 1
  }
  return commands[candidateIndex]!.id
}
