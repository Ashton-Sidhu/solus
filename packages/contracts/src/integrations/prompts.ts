/**
 * MCP prompts as slash commands (docs/plans/mcp-first-class.md §10). A server
 * lists prompts; the person starts one as `/<slug>:<prompt>`; the host expands
 * it, and the text is the person's message for Claude and for Codex alike.
 */

import { z } from 'zod'
import type { Attachment } from '../types'

/** The longest expanded prompt text. Past it the text is cut and a `[Left out: …]` line names this limit. */
export const MAX_MCP_PROMPT_TEXT_CHARS = 100_000
/** The longest value of one argument. */
export const MAX_MCP_PROMPT_ARGUMENT_CHARS = 20_000
/** The most prompts one server adds to the slash menu. */
export const MAX_MCP_PROMPTS_PER_SERVER = 200

export interface IntegrationPromptArgument {
  name: string
  description?: string
  required: boolean
}

/** One MCP prompt of one of the caller's integrations. */
export interface IntegrationPrompt {
  integrationId: string
  /** The server's name, as Settings → MCP shows it. */
  integrationName: string
  /** `/<slug>:<prompt>`: what the person types. */
  command: string
  /** The prompt's name on its server; `integrationPromptGet` takes it. */
  name: string
  title?: string
  description?: string
  arguments: IntegrationPromptArgument[]
}

/**
 * One of the caller's servers whose prompts need the caller's connection first.
 * `sign-in` opens the sign-in; `environment` asks for a command's values.
 */
export interface IntegrationPromptSignIn {
  integrationId: string
  integrationName: string
  slug: string
  needs: 'sign-in' | 'environment'
}

export interface IntegrationPromptList {
  prompts: IntegrationPrompt[]
  signIn: IntegrationPromptSignIn[]
}

export const integrationPromptListRequestSchema = z.object({
  /** The conversation's working directory: a project's integration lists only for its project (§8.4). */
  projectPath: z.string().min(1).max(4096).optional(),
}).strict()
export type IntegrationPromptListRequest = z.infer<typeof integrationPromptListRequestSchema>

export const integrationPromptGetRequestSchema = z.object({
  integrationId: z.string().min(1),
  name: z.string().min(1).max(400),
  arguments: z.array(z.object({ name: z.string().min(1).max(200), value: z.string().max(MAX_MCP_PROMPT_ARGUMENT_CHARS) }).strict()).max(50),
  /** The conversation the message goes to: its images go to its attachment folder, and a missing connection shows its connect card. */
  sessionId: z.string().min(1).optional(),
  /** A draft with no session yet: its images go to the draft's folder. */
  draftId: z.string().min(1).optional(),
}).strict()
export type IntegrationPromptGetRequest = z.infer<typeof integrationPromptGetRequestSchema>

/**
 * The expanded prompt, or the caller's missing connection. A connection is
 * not an error: the client shows the connect card or the server's row in
 * Settings → MCP. Every other failure is an error with the reason.
 */
export type IntegrationPromptText =
  | { kind: 'text'; text: string; attachments: Attachment[] }
  | { kind: 'connection-required'; integrationId: string; integrationName: string; needs: IntegrationPromptSignIn['needs'] }

/** The command of one prompt: a character outside `[A-Za-z0-9._-]` in its name becomes `_`, as tool names do. */
export function integrationPromptCommand(slug: string, name: string): string {
  return `/${slug}:${name.replace(/[^A-Za-z0-9._-]/g, '_')}`
}
