/**
 * Which name a host row prints.
 *
 * A saved entry's label is a guess frozen at pairing time — the address the user
 * dialed, or whatever the host called itself back then. It never moves again: the
 * account directory records the label the host enrolled with, and `/health`
 * withholds the machine name over a tunnel, so a remote or SaaS client has no
 * other way to notice that the machine has since been renamed. The capability
 * record does: it rides the authenticated connection and reloads on every
 * reconnect.
 *
 * The exception is a name the user typed. Renaming the machine must not rewrite
 * their wording, so `hasUserLabel` outranks the host's own answer.
 */
export function hostRowLabel(
  saved: { label: string; hasUserLabel?: boolean },
  reportedName: string | undefined,
): string {
  if (saved.hasUserLabel) return saved.label
  return reportedName || saved.label
}
