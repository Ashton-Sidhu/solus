import { createLogger } from '../logger'
import { git } from './exec'

const log = createLogger('PullRequestDraft', 'pr-draft.ts')

const MAX_DIFF_CHARS = 100_000
const MAX_CONTEXT_CHARS = 140_000

export interface PullRequestDraft {
  title: string
  body: string
}

export interface PullRequestDraftInput {
  cwd: string
  baseBranch: string
  headBranch: string
  generateText: (prompt: string) => Promise<string>
}

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[Diff truncated at ${MAX_DIFF_CHARS} characters.]`
}

function collectGitContext(input: PullRequestDraftInput): string | null {
  const stat = git(['diff', '--stat', `${input.baseBranch}...HEAD`], input.cwd)
  const nameStatus = git(['diff', '--name-status', `${input.baseBranch}...HEAD`], input.cwd)
  const logOutput = git(['log', '--oneline', `${input.baseBranch}..HEAD`], input.cwd)
  const diff = truncateDiff(git(['diff', `${input.baseBranch}...HEAD`], input.cwd))

  const context = [
    `Base branch: ${input.baseBranch}`,
    `Head branch: ${input.headBranch}`,
    '',
    'git diff --stat:',
    stat || '(empty)',
    '',
    'git diff --name-status:',
    nameStatus || '(empty)',
    '',
    'git log --oneline:',
    logOutput || '(empty)',
    '',
    'git diff:',
    diff || '(empty)',
  ].join('\n')

  return context.length > MAX_CONTEXT_CHARS ? null : context
}

function buildPrompt(context: string): string {
  return [
    'You are generating a GitHub pull request title and body.',
    '',
    'Use only the provided git context. Do not invent tests or implementation details.',
    '',
    'Return strict JSON only:',
    '{',
    '  "title": "short imperative title",',
    '  "body": "markdown body"',
    '}',
    '',
    'Body format:',
    '## Summary',
    '- ...',
    '',
    '## Testing',
    '- ...',
    '',
    'If no tests are evident from the context, use:',
    '## Testing',
    '- Not run (not specified).',
    '',
    'Git context:',
    context,
  ].join('\n')
}

function parseDraft(text: string): PullRequestDraft | null {
  const candidates: string[] = []

  // Fenced code block anywhere in the text (e.g. preamble then ```json{...}```)
  const fencedMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i)
  if (fencedMatch) candidates.push(fencedMatch[1].trim())

  // Outermost {...} block (handles preamble/postamble text around bare JSON)
  const braceMatch = text.match(/\{[\s\S]*\}/)
  if (braceMatch) candidates.push(braceMatch[0])

  // Raw trimmed text as last resort
  candidates.push(text.trim())

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<PullRequestDraft>
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
      const body = typeof parsed.body === 'string' ? parsed.body.trim() : ''
      if (title && body) return { title, body }
    } catch {
      // try next candidate
    }
  }
  return null
}

export async function generatePullRequestDraft(input: PullRequestDraftInput): Promise<PullRequestDraft | null> {
  try {
    const context = collectGitContext(input)
    if (!context) {
      log.warn('Skipping PR draft generation: git context exceeded size limit after truncation')
      return null
    }

    const text = await input.generateText(buildPrompt(context))
    const draft = parseDraft(text)
    if (!draft) log.warn('PR draft generation returned invalid JSON')
    return draft
  } catch (err: any) {
    log.warn(`PR draft generation failed: ${err?.message || err}`)
    return null
  }
}
