export type PrActivityDataSource =
  | 'details'
  | 'commits'
  | 'comments'
  | 'reviewers'
  | 'reviewer-candidates'
  | 'changed-files'

const SOURCE_LABELS: Record<PrActivityDataSource, string> = {
  details: 'pull request details',
  commits: 'commits',
  comments: 'comments',
  reviewers: 'reviewers',
  'reviewer-candidates': 'reviewer candidates',
  'changed-files': 'changed files',
}

export function prActivityLoadFailureMessage(
  failedSources: Iterable<PrActivityDataSource>,
  threadsFailed: boolean,
): string | null {
  const labels = [...failedSources].map((source) => SOURCE_LABELS[source])
  if (threadsFailed) labels.push('review threads')
  if (labels.length === 0) return null

  const failed = labels.length === 1
    ? labels[0]
    : labels.length === 2
      ? `${labels[0]} and ${labels[1]}`
      : `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`
  return `Couldn’t load ${failed}. Check your connection or provider sign-in.`
}
