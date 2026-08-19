interface RenameInputTarget {
  scrollLeft: number
  focus(): void
  select(): void
}

/** Focus a mounted rename field and select its title for replacement. */
export function focusRenameInputText(target: RenameInputTarget): void {
  target.focus()
  target.select()
  target.scrollLeft = 0
}

/** Return a durable rename only when it is non-empty and changed. */
export function committedRenameValue(draft: string, current: string): string | null {
  const next = draft.trim()
  return next && next !== current ? next : null
}
