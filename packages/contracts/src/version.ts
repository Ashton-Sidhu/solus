/**
 * One version comparator for every place Solus asks "is this older?": the CLI
 * self-update, the host update check, and the client's per-host skew notice.
 * Dotted integers only; a prerelease suffix on a part is ignored, so `1.2.0-rc1`
 * sorts with `1.2.0`. Solus never ships prerelease tags to a feed.
 */

/** Strips a leading `v` and surrounding whitespace: a GitHub tag as a version. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, '')
}

function numericParts(version: string): number[] {
  return normalizeVersion(version).split('.').map((part) => Number.parseInt(part, 10) || 0)
}

/** Negative when `a` is older than `b`, positive when newer, zero when equal. */
export function compareVersions(a: string, b: string): number {
  const left = numericParts(a)
  const right = numericParts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function isOlderVersion(candidate: string, reference: string): boolean {
  return compareVersions(candidate, reference) < 0
}
