import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import { parseReviewCommand, type ReviewGuideTarget } from '@solus/contracts/review'

export interface DirectReviewRequest {
  target: ReviewGuideTarget
  instructions?: string
}

function withInstructions(target: ReviewGuideTarget, value: string): DirectReviewRequest {
  const instructions = value.trim().slice(0, 20_000)
  return instructions ? { target, instructions } : { target }
}

/** Resolve the review commands Solus owns before they reach a provider. Raw
 * skill syntax remains accepted for people who type it manually, although the
 * author-only skill is hidden from provider command discovery. */
export function directReviewRequest(prompt: string): DirectReviewRequest | null {
  const trimmed = prompt.trim()
  const rawSkill = trimmed.match(/^\/(?:solus:)?solus-review(?:[ \t]+([^\n]*))?(?:\n([\s\S]*))?$/i)
  if (rawSkill) {
    return withInstructions(
      { kind: 'working-tree' },
      [rawSkill[1], rawSkill[2]].filter(Boolean).join('\n'),
    )
  }

  const command = parseReviewCommand(prompt)
  if (!command || command.mode === 'session') return null
  if (command.mode === 'pr') {
    if (!command.argument) return null
    const parsed = parseGitHubPullRequestUrl(command.argument)
    if (!parsed) return null
    return withInstructions({
      kind: 'pr',
      host: parsed.baseRepo.host,
      owner: parsed.baseRepo.owner,
      repo: parsed.baseRepo.repo,
      number: parsed.number,
      url: parsed.url,
    }, command.context ?? '')
  }
  if (command.mode === 'branch') {
    const target: ReviewGuideTarget = command.argument
      ? { kind: 'branch', targetBranch: command.argument }
      : { kind: 'branch' }
    return withInstructions(target, command.context ?? '')
  }
  return withInstructions({ kind: 'working-tree' }, [command.argument, command.context].filter(Boolean).join('\n'))
}
