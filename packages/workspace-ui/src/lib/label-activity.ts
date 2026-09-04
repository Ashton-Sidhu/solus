/** One readable audit sentence for labels added and/or removed from a record. */
export function labelChangeText(
  who: string,
  added: string[],
  removed: string[],
): string {
  const changes = [
    ...(added.length ? [labelAction('added', added)] : []),
    ...(removed.length ? [labelAction('removed', removed)] : []),
  ]
  if (!changes.length) throw new Error('Label activity requires an added or removed label')
  return `${who} ${changes.join(' and ')}`
}

function labelAction(action: 'added' | 'removed', labels: string[]): string {
  return `${action} ${labels.length === 1 ? 'label' : 'labels'} ${quotedLabels(labels)}`
}

function quotedLabels(labels: string[]): string {
  const quoted = labels.map((label) => `“${label}”`)
  if (quoted.length < 2) return quoted[0] ?? ''
  return quoted.length === 2
    ? `${quoted[0]} and ${quoted[1]}`
    : `${quoted.slice(0, -1).join(', ')}, and ${quoted.at(-1)}`
}
