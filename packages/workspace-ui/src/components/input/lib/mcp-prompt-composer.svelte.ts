import type { IntegrationPrompt, IntegrationPromptSignIn } from '@solus/contracts/integrations/prompts'
import { worktreeProjectRoot, type Attachment } from '@solus/contracts/types'
import { filledArguments, promptFromLine, promptStart, type ArgumentValue } from '@solus/client-core/integration-prompts'
import { mcpStore } from '../../../contexts/mcp'

/**
 * MCP prompts in one composer (docs/plans/mcp-first-class.md §10): a row of
 * the slash menu, or a typed `/<slug>:<prompt>` line, starts a prompt. The
 * host expands it, and the text goes as the person's own message through the
 * composer's normal send, so Claude and Codex get the same text and the
 * transcript shows what was sent. A prompt with a required argument never
 * goes without it: it opens the argument form instead.
 */

/** What a row of the slash menu's MCP band starts. */
export type McpPromptChoice =
  | { kind: 'prompt'; prompt: IntegrationPrompt }
  | { kind: 'sign-in'; server: Pick<IntegrationPromptSignIn, 'integrationId' | 'integrationName'> }

export interface McpPromptForm {
  prompt: IntegrationPrompt
  values: ArgumentValue[]
  isSending: boolean
  error: string
}

interface McpPromptComposerDeps {
  serverId(): string | undefined
  projectPath(): string | undefined
  sessionId(): string | null
  draftId(): string | undefined
  /** Sends the text and its attachments as the person's message; false when the composer did not take it. */
  send(text: string, attachments: Attachment[]): boolean
  /** A reason in the conversation, or a toast for a draft. The draft stays. */
  report(message: string): void
  /** The connect card in a conversation, the server's place in Settings → MCP from a draft. */
  openSignIn(server: Pick<IntegrationPromptSignIn, 'integrationId' | 'integrationName'>): void
  setComposerText(text: string): void
  clearComposer(): void
  refocus(): void
}

export type McpPromptComposer = ReturnType<typeof useMcpPromptComposer>

export function useMcpPromptComposer(deps: McpPromptComposerDeps) {
  let form = $state<McpPromptForm | null>(null)
  /** One expansion at a time: a second Enter while the host answers does nothing. */
  let isExpanding = false

  function knownPrompts(): IntegrationPrompt[] {
    const serverId = deps.serverId()
    // The lists are kept for the project, so every worktree of it shares one (§10).
    const projectPath = deps.projectPath()
    return serverId ? mcpStore.prompts.listFor(serverId, projectPath && worktreeProjectRoot(projectPath)).prompts : []
  }

  async function expand(prompt: IntegrationPrompt, values: ArgumentValue[]): Promise<void> {
    const serverId = deps.serverId()
    if (!serverId || isExpanding) return
    isExpanding = true
    const sessionId = deps.sessionId()
    const draftId = deps.draftId()
    try {
      const answer = await mcpStore.prompts.expand(serverId, {
        integrationId: prompt.integrationId,
        name: prompt.name,
        arguments: filledArguments(values),
        ...(sessionId ? { sessionId } : draftId ? { draftId } : {}),
      })
      if (answer.kind === 'connection-required') {
        form = null
        deps.openSignIn(answer)
        return
      }
      const attachments = answer.attachments.map((attachment) => ({ ...attachment, hostServerId: serverId }))
      if (!deps.send(answer.text, attachments)) {
        if (form) form = { ...form, isSending: false, error: 'The message was not sent.' }
        return
      }
      form = null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (form) form = { ...form, isSending: false, error: message }
      else {
        deps.report(message)
        deps.refocus()
      }
    } finally {
      isExpanding = false
    }
  }

  function start(prompt: IntegrationPrompt, rest: string): void {
    const next = promptStart(prompt, rest)
    if (next.kind === 'refused') {
      deps.report(next.message)
      deps.refocus()
    } else if (next.kind === 'form') form = { prompt, values: next.values, isSending: false, error: '' }
    else void expand(prompt, next.values)
  }

  return {
    get form() {
      return form
    },
    /** A typed line was sent. True when it starts an MCP prompt: the caller sends nothing else, and the line stays until the prompt is sent. */
    startFromLine(line: string): boolean {
      const found = promptFromLine(line, knownPrompts())
      if (!found) return false
      start(found.prompt, found.rest)
      return true
    },
    /** A row of the slash menu was chosen. One argument takes the rest of the line, as a typed command does. */
    choose(choice: McpPromptChoice): void {
      if (choice.kind === 'sign-in') {
        deps.clearComposer()
        deps.openSignIn(choice.server)
        return
      }
      if (choice.prompt.arguments.length === 1) {
        deps.setComposerText(`${choice.prompt.command} `)
        deps.refocus()
        return
      }
      deps.clearComposer()
      start(choice.prompt, '')
    },
    submitForm(values: ArgumentValue[]): void {
      if (!form) return
      form = { ...form, values, isSending: true, error: '' }
      void expand(form.prompt, values)
    },
    closeForm(): void {
      form = null
      deps.refocus()
    },
  }
}
