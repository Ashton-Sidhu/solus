import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { createLogger } from '../logger'
import { bundledResourcesDir } from '../platform/paths'
import type { AgentTool } from '../execution/agents/tools/agent-tool'
import type { WritingBackend } from '../execution/agents/writing-backend'
import type { TextGenerator } from '../execution/agents/text-generator'
import { runAsync } from './exec'

const log = createLogger('PullRequestAuthoring', 'pull-request-authoring.ts')

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
  /** Null when no backend the caller can run is installed: the draft is then written from the commits. */
  backend: WritingBackend | null
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
    // A template is optional: a path the base does not hold is not an error.
    const template = await runAsync('git', ['show', `${baseRef}:${templatePath}`], cwd, { raw: true })
      .catch(() => '')
    if (template.trim()) return limit(template.trim(), MAX_TEMPLATE_CHARS)
  }
  return null
}

/**
 * What the branch changes, read as the acting identity: in a partial clone a
 * diff fetches file contents it does not hold yet.
 * A failed log or diff is an error, never an empty change; only a patch too
 * large to read is left out, and its stat still describes it.
 */
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
    runAsync('git', ['log', '--no-merges', '--pretty=format:%s', range], cwd),
    runAsync('git', ['diff', '--stat', diffRange], cwd),
    runAsync('git', ['diff', '--no-ext-diff', '--unified=3', diffRange], cwd, {
      maxBuffer: MAX_DIFF_PATCH_BYTES,
    }).catch((error) => {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return ''
      throw error
    }),
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

function bodyRulesFromSkill(skill: string): string[] {
  const section = skill.split(/^## Body rules$/m)[1]?.split(/^## /m)[0] ?? ''
  return section.split(/\r?\n/).filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim())
}

/**
 * The house rules for a pull request body. The bundled `writing-pr` skill owns
 * them, so an agent that opens a pull request itself follows the same rules as
 * the git action. They are the maintainers' own wording; the skill keeps them
 * as one bullet each under `## Body rules`.
 */
export async function readHouseBodyRules(): Promise<string[]> {
  const skillPath = join(bundledResourcesDir(), 'plugins', 'solus', 'skills', 'writing-pr', 'SKILL.md')
  try {
    return bodyRulesFromSkill(await readFile(skillPath, 'utf8'))
  } catch (error) {
    // A missing skill degrades the draft; it must not block the pull request.
    log.warn('pull_request_body_rules_missing', { skillPath, error: error instanceof Error ? error.message : String(error) })
    return []
  }
}

export function buildPullRequestAuthoringPrompt(
  context: PullRequestAuthoringContext,
  houseBodyRules: readonly string[],
  instructions = 'Use concise, specific source-control writing.',
): string {
  const bodyRules = context.template
    ? [
        'Follow the repository pull request template.',
        'Fill its sections with facts from the commits and diff.',
        'Keep its Markdown structure and remove HTML comments.',
        'Fill a testing or validation section only because the template asks for one.',
      ]
    : houseBodyRules
  return [
    'Write a pull request title and body for the complete branch change.',
    'Submit both fields with the provided tool. Do not answer with prose.',
    'The title must be concise, specific, and describe the user-visible outcome.',
    'Never invent a link, an image, or a number that the commits and diff do not contain.',
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
  const { backend } = writer
  if (!backend) return fallbackPullRequestDraft(context)
  let submitted: PullRequestDraft | null = null
  await writer.textGenerator.generate({
    provider: backend.provider,
    model: backend.model,
    seat: backend.seat,
    cwd,
    prompt: buildPullRequestAuthoringPrompt(context, await readHouseBodyRules(), writer.instructions),
    tools: [createDraftTool((draft) => { submitted = draft })],
    unattended: true,
    reasoningEffort: 'low',
    maxTurns: 2,
    timeoutMs: 60_000,
  }).catch(() => '')
  return submitted ?? fallbackPullRequestDraft(context)
}
