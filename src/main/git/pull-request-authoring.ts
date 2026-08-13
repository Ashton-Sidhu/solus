import { z } from 'zod'
import type { AgentTool } from '../agents/tools/agent-tool'
import type { TextGenerator } from '../agents/text-generator'
import type { AgentId } from '../../shared/types'
import { runAsync } from './exec'

const MAX_COMMIT_SUMMARY_CHARS = 12_000
const MAX_DIFF_STAT_CHARS = 12_000
const MAX_DIFF_PATCH_CHARS = 40_000
const MAX_DIFF_PATCH_BYTES = 2_000_000
const MAX_TEMPLATE_CHARS = 8_000

const TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
] as const

export interface PullRequestDraft {
  title: string
  body: string
}

export interface PullRequestAuthoringContext {
  baseBranch: string
  headBranch: string
  commitSummary: string
  diffStat: string
  diffPatch: string
  template: string | null
}

export interface PullRequestWriter {
  provider: AgentId
  model?: string | null
  textGenerator: TextGenerator
  instructions: string
  followPullRequestTemplate: boolean
}

function limit(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max).trimEnd()}\n\n[truncated]`
}

async function resolveBaseRef(cwd: string, baseBranch: string): Promise<string> {
  const remoteRef = `origin/${baseBranch}`
  const exists = await runAsync('git', ['rev-parse', '--verify', remoteRef], cwd).then(
    () => true,
    () => false,
  )
  return exists ? remoteRef : baseBranch
}

async function readTemplate(cwd: string, baseRef: string): Promise<string | null> {
  for (const templatePath of TEMPLATE_PATHS) {
    const template = await runAsync('git', ['show', `${baseRef}:${templatePath}`], cwd, { raw: true })
      .catch(() => '')
    if (template.trim()) return limit(template.trim(), MAX_TEMPLATE_CHARS)
  }
  return null
}

export async function readPullRequestAuthoringContext(
  cwd: string,
  baseBranch: string,
  headBranch: string,
  followPullRequestTemplate = true,
): Promise<PullRequestAuthoringContext> {
  const baseRef = await resolveBaseRef(cwd, baseBranch)
  const range = `${baseRef}..HEAD`
  const diffRange = `${baseRef}...HEAD`
  const [commitSummary, diffStat, diffPatch, template] = await Promise.all([
    runAsync('git', ['log', '--no-merges', '--pretty=format:%s', range], cwd).catch(() => ''),
    runAsync('git', ['diff', '--stat', diffRange], cwd).catch(() => ''),
    runAsync('git', ['diff', '--no-ext-diff', '--unified=3', diffRange], cwd, {
      maxBuffer: MAX_DIFF_PATCH_BYTES,
    }).catch(() => ''),
    followPullRequestTemplate ? readTemplate(cwd, baseRef) : Promise.resolve(null),
  ])
  return {
    baseBranch,
    headBranch,
    commitSummary: limit(commitSummary, MAX_COMMIT_SUMMARY_CHARS),
    diffStat: limit(diffStat, MAX_DIFF_STAT_CHARS),
    diffPatch: limit(diffPatch, MAX_DIFF_PATCH_CHARS),
    template,
  }
}

export function buildPullRequestAuthoringPrompt(
  context: PullRequestAuthoringContext,
  instructions = 'Use concise, specific source-control writing.',
): string {
  const bodyRules = context.template
    ? [
        'Follow the repository pull request template.',
        'Fill its sections with facts from the commits and diff.',
        'Keep its Markdown structure and remove HTML comments.',
      ]
    : [
        'When the writing policy does not specify a body structure, use Markdown headings "## Summary" and "## Testing".',
        'Use short bullets under both headings.',
        'Under Testing, report only checks supported by the input. Use "Not run" when no checks are present.',
      ]
  return [
    'Write a pull request title and body for the complete branch change.',
    'Submit both fields with the provided tool. Do not answer with prose.',
    'The title must be concise, specific, and describe the user-visible outcome.',
    'Do not claim tests passed unless the commits or diff say so.',
    '',
    'Writing policy:',
    instructions,
    ...bodyRules,
    '',
    `Base branch: ${context.baseBranch}`,
    `Head branch: ${context.headBranch}`,
    '',
    'Commits:',
    context.commitSummary || '(none)',
    '',
    'Diff stat:',
    context.diffStat || '(none)',
    '',
    'Diff patch:',
    context.diffPatch || '(none)',
    ...(context.template ? ['', 'Repository pull request template:', context.template] : []),
  ].join('\n')
}

function sanitizeTitle(value: string): string {
  const title = value.trim().split(/\r?\n/, 1)[0]?.trim().replace(/[.]+$/, '') ?? ''
  return title.slice(0, 200).trimEnd()
}

function sanitizeBody(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/g, '').trim()
}

function createDraftTool(capture: (draft: PullRequestDraft) => void): AgentTool {
  return {
    name: 'submit_pull_request_draft',
    description: 'Submit the final pull request title and Markdown body as the only answer.',
    inputFields: {
      title: z.string().describe('A concise, specific pull request title.'),
      body: z.string().describe('The complete Markdown pull request body.'),
    },
    requiresApproval: false,
    execute: async (args) => {
      const title = sanitizeTitle(args.title)
      const body = sanitizeBody(args.body)
      if (!title || !body) return { ok: false, text: 'Both title and body are required.' }
      capture({ title, body })
      return { ok: true, text: 'Pull request draft submitted.' }
    },
  }
}

export function fallbackPullRequestDraft(context: PullRequestAuthoringContext): PullRequestDraft {
  const firstCommit = context.commitSummary.split(/\r?\n/).find((line) => line.trim())?.trim()
  const title = sanitizeTitle(firstCommit || `Update ${context.headBranch}`) || 'Update project changes'
  if (context.template) {
    const body = sanitizeBody(context.template)
    if (body) return { title, body }
  }
  return {
    title,
    body: [
      '## Summary',
      '',
      context.diffStat ? `- ${context.diffStat.split(/\r?\n/).join('\n- ')}` : '- Update project changes.',
      '',
      '## Testing',
      '',
      '- Not run',
    ].join('\n'),
  }
}

export async function authorPullRequest(
  cwd: string,
  baseBranch: string,
  headBranch: string,
  writer: PullRequestWriter,
): Promise<PullRequestDraft> {
  const context = await readPullRequestAuthoringContext(
    cwd,
    baseBranch,
    headBranch,
    writer.followPullRequestTemplate,
  )
  let submitted: PullRequestDraft | null = null
  await writer.textGenerator.generate({
    provider: writer.provider,
    model: writer.model,
    cwd,
    prompt: buildPullRequestAuthoringPrompt(context, writer.instructions),
    tools: [createDraftTool((draft) => { submitted = draft })],
    unattended: true,
    reasoningEffort: 'low',
    maxTurns: 2,
    timeoutMs: 60_000,
  }).catch(() => '')
  return submitted ?? fallbackPullRequestDraft(context)
}
