import { randomUUID } from 'node:crypto'
import type { GetPromptResult } from '@modelcontextprotocol/client'
import { MAX_MCP_PROMPT_TEXT_CHARS } from '@solus/contracts/integrations/prompts'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'
import type { Attachment } from '@solus/contracts/types'
import { storeAttachment } from '../data/assets/attachment-store'
import { audioAssetExtension, rasterImageMimeOf } from '../data/assets/assets'
import { formatByteSize, leftOutLine } from '../data/assets/tool-result-media'
import { agentResultOf } from './result-content'

/**
 * The messages of `prompts/get` as one message of the person
 * (docs/plans/mcp-first-class.md §10). A provider takes one user input for a
 * turn, so the host makes one text: a user message's text as it is, an
 * assistant message's text under "Assistant:", an image or audio as an
 * attachment in the conversation's attachment store (the only place a run
 * reads an image from), and every other part as §6 maps it. The text comes
 * from a server, so it is data: it is cut at `MAX_MCP_PROMPT_TEXT_CHARS`, and a
 * `[Left out: …]` line names each part a limit or a check left out.
 */

export interface PromptContentOptions {
  /** The prompt's name: it names the saved files. */
  prompt: string
  /** The conversation folder of the attachment store; null when the request named no conversation. */
  bucketId: string | null
  /** A test passes temporary folders. */
  attachmentsDir?: string
  assetsDir?: string
}

export interface PromptContent {
  text: string
  attachments: Attachment[]
}

const IMAGE_EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

export async function promptContentOf(result: GetPromptResult, options: PromptContentOptions): Promise<PromptContent> {
  const attachments: Attachment[] = []
  const texts: string[] = []
  const counts = { image: 0, audio: 0 }

  /** Saves one image or audio part as an attachment; answers the line that replaces it, or null when it is attached. */
  const attach = async (kind: 'image' | 'audio', declared: string, data: string): Promise<string | null> => {
    const mimeType = declared.toLowerCase().split(';', 1)[0].trim()
    const label = `${kind} ${++counts[kind]}`
    if (!options.bucketId) return leftOutLine(`${label} (${mimeType}). Send the prompt from a conversation to attach it.`)
    if (data.length > Math.ceil(MAX_ATTACHMENT_UPLOAD_BYTES / 3) * 4) return leftOutLine(`${label} (${mimeType}). An attachment may be at most ${formatByteSize(MAX_ATTACHMENT_UPLOAD_BYTES)}.`)
    const bytes = Buffer.from(data, 'base64')
    const extension = kind === 'image'
      ? (rasterImageMimeOf(bytes) === mimeType ? IMAGE_EXTENSION[mimeType] : undefined)
      : audioAssetExtension(mimeType, bytes) ?? undefined
    if (!extension) return leftOutLine(`${label} (${mimeType}). Its bytes are not that ${kind} type, or Solus does not attach it.`)
    const name = `${options.prompt.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}-${label.replace(' ', '-')}.${extension}`
    try {
      const hostPath = await storeAttachment(options.bucketId, { name, mime: mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` }, options.attachmentsDir)
      attachments.push({ id: randomUUID(), type: kind === 'image' ? 'image' : 'file', name, path: hostPath, hostPath, mimeType, size: bytes.length })
      return null
    } catch (error) {
      return leftOutLine(`${label} (${mimeType}, ${formatByteSize(bytes.length)}). ${error instanceof Error ? error.message : 'The host could not save it.'}`)
    }
  }

  for (const message of result.messages) {
    const content = message.content
    const lines: string[] = []
    if (content.type === 'text') lines.push(content.text)
    else if (content.type === 'image' || content.type === 'audio') {
      const line = await attach(content.type, content.mimeType, content.data)
      if (line) lines.push(line)
    } else {
      // A resource, a resource link, or a later type: as a tool result maps it (§6).
      const mapped = await agentResultOf({ content: [content] }, { tool: options.prompt, assetsDir: options.assetsDir })
      if (mapped.text) lines.push(mapped.text)
      for (const image of mapped.images ?? []) {
        const line = await attach('image', image.mimeType, image.data)
        if (line) lines.push(line)
      }
    }
    if (!lines.length) continue
    const text = lines.join('\n\n')
    texts.push(message.role === 'assistant' ? `Assistant:\n${text}` : text)
  }

  let text = texts.join('\n\n')
  if (text.length > MAX_MCP_PROMPT_TEXT_CHARS) {
    const cut = text.length - MAX_MCP_PROMPT_TEXT_CHARS
    text = `${text.slice(0, MAX_MCP_PROMPT_TEXT_CHARS)}\n\n${leftOutLine(`the last ${cut.toLocaleString('en-US')} characters of the prompt. A prompt sends at most ${MAX_MCP_PROMPT_TEXT_CHARS.toLocaleString('en-US')} characters.`)}`
  }
  return { text, attachments }
}
