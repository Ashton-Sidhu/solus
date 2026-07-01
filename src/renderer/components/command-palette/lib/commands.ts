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
  /** Optional leading icon (phosphor-svelte component). */
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
