/**
 * `gh pr view` answers with a pull request's web URL, and everything downstream
 * — posting a comment, attaching evidence — needs its number. This is the whole
 * of that mapping, kept apart from the evidence loop so it can be checked
 * without a database behind it.
 */
export function pullRequestNumber(url: string): number | null {
  const match = /\/pull\/(\d+)(?:\D|$)/.exec(url)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
