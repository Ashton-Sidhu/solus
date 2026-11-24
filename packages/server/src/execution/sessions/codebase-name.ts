import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_CODEBASE_NAMING, validGeneratedCodebaseName, type CodebaseNaming } from '@solus/contracts/codebases'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import type { AgentDispatcher } from '../agents/agent-runner'
import { TextGenerator } from '../agents/text-generator'
import type { AgentTool } from '../agents/tools/agent-tool'
import { writingBackendFor } from '../agents/writing-backend'
import { resolveTextGenerationModel } from '../../host/settings'
import { createLogger } from '../../logger'
import { loadProjectConfig } from '../../project-config/project-config'
import type { SeatResolver } from '../seats/seat-manager'

const log = createLogger('SessionRuntime', 'codebase-name.ts')

/**
 * The short name of a codebase that Solus forms from separate projects
 * (docs/plans/codebases.md decision 13). The codebase forms at once with its
 * plain name. This module asks a small model for a better one, the way Solus
 * names a session and a worktree: the writing model of the person, on their
 * seat, in one short run with one tool.
 */

const CODEBASE_NAME_TOOL = 'submit_codebase_name'
/** What the model reads of each README: enough to say what the project is. */
const README_BYTES = 600
const README_NAMES = ['README.md', 'readme.md', 'README']

const codebaseNameSchema = z.object({ name: z.string().min(1) })

/** One folder of the codebase, as the model reads it. */
export interface NamedFolder {
  name: string
  /** On this host. A folder on a different host has no path here, and its README is not read. */
  path?: string
}

/**
 * How Solus names a codebase that it forms: the `.solus/config.json` of the
 * project folder, else the setting of the person, else the default. The same
 * order as the name of a worktree branch (`resolveWorktreeBranchNamer`).
 */
export async function resolveCodebaseNaming(projectFolder: string, personal: CodebaseNaming | undefined): Promise<CodebaseNaming> {
  return (await loadProjectConfig(projectFolder))?.codebaseNaming ?? personal ?? DEFAULT_CODEBASE_NAMING
}

function codebaseNameTool(capture: (name: string) => void): AgentTool {
  return {
    name: CODEBASE_NAME_TOOL,
    description: 'Submit the short name for the set of projects. This call is your whole answer.',
    inputFields: {
      name: z.string().describe('One to three words, letters and digits only, at most 32 characters.'),
    },
    requiresApproval: false,
    // A deferred tool costs a tool-search turn, and the run has only two.
    alwaysLoad: true,
    execute: async (args) => {
      const { name } = codebaseNameSchema.parse(args)
      capture(name)
      return { ok: true, text: `Named the codebase "${name}".` }
    },
  }
}

/** The first bytes of the README of a folder, as one line. Empty when it has none. */
async function readmeStartOf(folder: string): Promise<string> {
  for (const name of README_NAMES) {
    const file = await open(join(folder, name), 'r').catch(() => null)
    if (!file) continue
    try {
      const { bytesRead, buffer } = await file.read(Buffer.alloc(README_BYTES), 0, README_BYTES, 0)
      return buffer.subarray(0, bytesRead).toString('utf-8').replace(/\s+/g, ' ').trim()
    } catch {
      return ''
    } finally {
      await file.close()
    }
  }
  return ''
}

async function promptFor(folders: readonly NamedFolder[]): Promise<string> {
  const lines = await Promise.all(folders.map(async (folder) => {
    const readme = folder.path ? await readmeStartOf(folder.path) : ''
    return readme ? `- ${folder.name}: ${readme}` : `- ${folder.name}`
  }))
  return [
    'Name the product or the system that these project folders are parts of.',
    `Submit the name by calling ${CODEBASE_NAME_TOOL} exactly once. The tool call is your whole answer.`,
    'Use one to three words, letters and digits only, no punctuation, at most 32 characters.',
    'Do not use generic words such as codebase, project, repository, or workspace.',
    'Do not explain or write prose.',
    '',
    'Folders:',
    ...lines,
  ].join('\n')
}

/**
 * Ask the writing model of the person for the name of a codebase of
 * `folders`. Null when no backend can run, when the run fails, and when the
 * answer is not a correct name (`validGeneratedCodebaseName`): the plain name
 * then stays. `cwd` is the project folder of the session.
 */
export async function generateCodebaseName(
  dispatcher: AgentDispatcher,
  folders: readonly NamedFolder[],
  cwd: string,
  seatFor: SeatResolver | undefined,
  preferences: Pick<ExecutionPreferences, 'textGenerationModel'> | undefined,
  organizationId: string,
): Promise<string | null> {
  const backend = await writingBackendFor(resolveTextGenerationModel(preferences), seatFor, organizationId)
  if (!backend) return null
  let submitted: string | null = null
  // The submission is the whole answer: the run stops there.
  const submission = new AbortController()
  try {
    await new TextGenerator(dispatcher).generate({
      organizationId: backend.organizationId,
      provider: backend.provider,
      model: backend.model,
      seat: backend.seat,
      reasoningEffort: 'low',
      cwd,
      prompt: await promptFor(folders),
      tools: [codebaseNameTool((name) => {
        submitted = name
        submission.abort()
      })],
      abortSignal: submission.signal,
      unattended: true,
      // A name needs no built-in tool and no setup of the person or the project.
      bare: { webAccess: false },
      maxTurns: 2,
      timeoutMs: 30_000,
    })
  } catch (error) {
    // A run that ends in error after the tool call still submitted its name.
    if (!submitted) log.warn('codebase_name_generation_failed', { provider: backend.provider, model: backend.model, error: error instanceof Error ? error.message : String(error) })
  }
  const name = submitted ? validGeneratedCodebaseName(submitted) : null
  log.info('codebase_name_generated', { provider: backend.provider, model: backend.model, submitted: submitted !== null, valid: name !== null })
  return name
}
