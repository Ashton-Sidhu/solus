import { describe, expect, test } from 'bun:test'
import { isRawReviewSkill, reviewSkillPrompt } from '@solus/server/agents/review-command'

/** What the composer appends when the session is bound to a task. */
const TASK_PACKET = [
  '[Working On Task "Review Plotly Graph Pull Request" (task_id: 01M1276WEFSNW4178JP9X9P3V8)]',
  'Call read_task with task_id "01M1276WEFSNW4178JP9X9P3V8" to read the latest status.',
].join('\n')

describe('review command provider routing', () => {
  test('Claude and Codex resolve every alias to the same bundled skill', () => {
    const commands = [
      '/review',
      '/review:working-tree',
      '/review:session',
      '/review:branch main',
      '/review:pr',
      '/review https://github.com/acme/app/pull/42',
    ]
    for (const command of commands) {
      expect(reviewSkillPrompt(command, 'claude-code')).toStartWith('/solus:solus-review\n')
      expect(reviewSkillPrompt(command, 'codex')).toStartWith('/solus-review\n')
      expect(reviewSkillPrompt(command, 'codex')).toContain('Host mode: request.')
    }
  })

  test('does not rewrite similar or embedded prose', () => {
    expect(reviewSkillPrompt('/reviewer', 'codex')).toBe('/reviewer')
    expect(reviewSkillPrompt('Please run /review', 'claude-code')).toBe('Please run /review')
  })

  // A task-bound session appends its packet below the command. Before this was
  // handled the command reached Claude Code verbatim, which rejects an unknown
  // slash command outright, so review was unusable from any bound session.
  test('routes the command when the composer appends a bound-task packet', () => {
    const prompt = `/review:working-tree\n\n${TASK_PACKET}`

    for (const provider of ['claude-code', 'codex'] as const) {
      const rewritten = reviewSkillPrompt(prompt, provider)
      expect(rewritten).toStartWith(provider === 'codex' ? '/solus-review\n' : '/solus:solus-review\n')
      expect(rewritten).toContain('Original review command: /review:working-tree')
      // The binding is context, not scope: it survives, below the mode.
      expect(rewritten).toContain(TASK_PACKET)
      expect(rewritten.indexOf('Host mode: request.')).toBeLessThan(rewritten.indexOf(TASK_PACKET))
    }
  })

  test('resolves the implicit modes so the skill never infers one', () => {
    expect(reviewSkillPrompt('/review', 'codex')).toContain('Original review command: /review:working-tree')
    expect(reviewSkillPrompt(`/review https://github.com/acme/app/pull/42\n\n${TASK_PACKET}`, 'codex'))
      .toContain('Original review command: /review:pr https://github.com/acme/app/pull/42')
  })

  test('hides the raw skill on both providers so only the aliases are typeable', () => {
    expect(isRawReviewSkill({ name: 'solus-review' })).toBe(true)        // Codex
    expect(isRawReviewSkill({ name: 'solus:solus-review' })).toBe(true)  // Claude, plugin-namespaced
    expect(isRawReviewSkill({ name: 'review:session' })).toBe(false)
    expect(isRawReviewSkill({ name: 'solus-review-notes' })).toBe(false)
  })
})
