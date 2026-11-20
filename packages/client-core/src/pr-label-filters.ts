/** Remove one label from its OR group, or add a new required group. Keep other groups intact. */
export function togglePrLabel(groups: readonly (readonly string[])[], label: string): string[][] {
  const key = label.toLowerCase()
  if (groups.some((group) => group.some((held) => held.toLowerCase() === key))) {
    return groups
      .map((group) => group.filter((held) => held.toLowerCase() !== key))
      .filter((group) => group.length > 0)
  }
  const next = groups.map((group) => [...group])
  if (next.length < 20) next.push([label])
  return next
}

/** Each group requires one label. Excluded labels always hide a row. */
export function matchesPrLabels(
  names: readonly string[],
  groups: readonly (readonly string[])[],
  excluded: readonly string[]
): boolean {
  const labels = new Set(names.map((name) => name.toLowerCase()))
  return (
    groups.every((group) => group.some((name) => labels.has(name.toLowerCase()))) &&
    !excluded.some((name) => labels.has(name.toLowerCase()))
  )
}
