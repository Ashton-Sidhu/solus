import { formatReviewCommand, parseReviewCommand } from '@solus/contracts/review'
import type { AgentId } from '@solus/contracts/types'

/** Both backends also advertise the bundled skill under its own name — Codex as
 *  `solus-review`, Claude as the plugin-namespaced `solus:solus-review`. Typing
 *  either reaches the skill with no host mode and no target, which the skill
 *  forbids, so the command list offers only the `/review:*` aliases. */
export function isRawReviewSkill(command: { name: string }): boolean {
  return /^(?:[a-z0-9-]+:)?solus-review$/i.test(command.name)
}

/** Provider invocation syntax stays at the agent boundary. Claude namespaces a
 *  plugin skill as `<plugin>:<skill>` and Codex does not, so no single literal
 *  the user types can reach the skill on both backends. */
export function reviewSkillPrompt(prompt: string, provider: AgentId): string {
  const command = parseReviewCommand(prompt)
  if (!command) return prompt
  const invocation = provider === 'codex' ? '/solus-review' : '/solus:solus-review'
  return [
    invocation,
    '',
    'Host mode: request.',
    `Original review command: ${formatReviewCommand(command)}`,
    // The composer appends the bound task and work packets below the command.
    // They are the session's binding, not review scope, so they follow the mode
    // rather than replacing it.
    ...(command.context ? ['', command.context] : []),
  ].join('\n')
}
