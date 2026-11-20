import type { IntegrationPrompt, IntegrationPromptList, IntegrationPromptSignIn } from '@solus/contracts/integrations/prompts'
import type { Attachment } from '@solus/contracts/types'
import type { ClipboardAttachmentRef } from '@solus/client-core/attachment-clipboard'

/**
 * The rows of the composer's "MCP Prompt" sheet (docs/plans/mcp-first-class.md
 * §10): the phone's way to the prompts that desktop and web list in the `/`
 * menu. One section for each server, in the order the host gave them, then
 * the servers that wait on the person's sign-in. The search matches the
 * command, the title, the description, and the server's name.
 */

export type McpPromptRow =
  | { kind: 'prompt'; key: string; prompt: IntegrationPrompt }
  | { kind: 'sign-in'; key: string; server: IntegrationPromptSignIn }

export interface McpPromptSection {
  title: string
  data: McpPromptRow[]
}

function matches(query: string, fields: ReadonlyArray<string | undefined>): boolean {
  return fields.some((field) => field?.toLowerCase().includes(query))
}

export function mcpPromptSections(list: IntegrationPromptList, query: string): McpPromptSection[] {
  const needle = query.trim().toLowerCase()
  const sections: McpPromptSection[] = []
  for (const prompt of list.prompts) {
    if (needle && !matches(needle, [prompt.command, prompt.title, prompt.description, prompt.integrationName])) continue
    let section = sections.find((candidate) => candidate.title === prompt.integrationName)
    if (!section) sections.push((section = { title: prompt.integrationName, data: [] }))
    section.data.push({ kind: 'prompt', key: `${prompt.integrationId}:${prompt.name}`, prompt })
  }
  const signIn = list.signIn.filter((server) => !needle || matches(needle, [server.integrationName, server.slug]))
  if (signIn.length) sections.push({ title: 'Sign in to use', data: signIn.map((server) => ({ kind: 'sign-in', key: `sign-in:${server.integrationId}`, server })) })
  return sections
}

/**
 * The files of an expanded prompt as refs on its host: the host saved them in
 * this conversation's attachment folder, so they join the message without an
 * upload, as a paste of a Solus message does.
 */
export function promptAttachmentRefs(attachments: readonly Attachment[], hostId: string): ClipboardAttachmentRef[] {
  return attachments.flatMap((attachment) => {
    if (!attachment.hostPath || attachment.type === 'design-selection') return []
    return [{ type: attachment.type, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, hostPath: attachment.hostPath, hostServerId: hostId }]
  })
}
