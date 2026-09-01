import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import type { TaskLinkInput } from '@solus/contracts/task-types'

export interface ExternalPrLinkCandidate {
  input: TaskLinkInput
  label: string
  meta: string
}

/** Turn a pasted GitHub PR URL into the durable snapshot a task link needs. */
export function externalPrLinkCandidate(value: string): ExternalPrLinkCandidate | null {
  const pr = parseGitHubPullRequestUrl(value)
  if (!pr) return null
  const repository = `${pr.baseRepo.owner}/${pr.baseRepo.repo}`
  return {
    input: {
      kind: 'pr',
      targetScope: `${pr.baseRepo.host}/${repository}`,
      targetKey: String(pr.number),
      title: `#${pr.number} ${repository}`,
      url: pr.url,
    },
    label: `#${pr.number}`,
    meta: repository,
  }
}
