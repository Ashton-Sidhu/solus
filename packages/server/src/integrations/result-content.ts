import { fromJsonSchema, ProtocolError, type CallToolResult, type CompatibilityCallToolResult, type ContentBlock } from '@modelcontextprotocol/client'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'
import { agentReadablePath } from '../data/assets/attachment-store'
import { audioAssetExtension, rasterImageMimeOf, writeAssetBytes } from '../data/assets/assets'
import { storedAssetPath } from '../data/assets/asset-paths'
import { MAX_TOOL_RESULT_IMAGES } from '../data/assets/transcript-images'
import { audioLine, formatByteSize, leftOutLine } from '../data/assets/tool-result-media'
import { downscalePng } from '../execution/agents/tools/bounded-png'
import {
  MAX_AGENT_TOOL_IMAGE_BYTES,
  MAX_AGENT_TOOL_IMAGE_EDGE,
  type AgentToolImage,
  type AgentToolImageType,
  type AgentToolResult,
} from '../execution/agents/tools/agent-tool'
import type { UpstreamTool } from './gateway'

/**
 * MCP content as an agent tool result (docs/plans/mcp-first-class.md §6). The
 * one mapper for MCP content: both providers get what it answers. Every part
 * reaches the agent: as text, as an image, as the host path of a saved file,
 * or as a `[Left out: …]` line that names the limit or the check that left it
 * out. Data from a server is untrusted: a type is checked against its bytes,
 * and a file name is the asset id, never the server's text.
 */

/** The images of one result together; a provider refuses a request past its own size limit. */
export const MAX_RESULT_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024
/** One saved file (audio, a blob, an image that could not be sent). */
export const MAX_RESULT_FILE_BYTES = MAX_ATTACHMENT_UPLOAD_BYTES
export const MAX_RESULT_FILES = 8
export const MAX_RESULT_FILE_TOTAL_BYTES = 25 * 1024 * 1024
/** The text of one result. */
export const MAX_RESULT_TEXT_CHARS = 200_000

const AGENT_IMAGE_TYPES: readonly AgentToolImageType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const RASTER_EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } satisfies Record<AgentToolImageType, string>
/** Other declared types a saved file keeps an extension for, so an agent's tools know it. None is served inline. */
const FILE_EXTENSION = new Map([
  ['application/pdf', 'pdf'],
  ['application/json', 'json'],
  ['application/zip', 'zip'],
  ['image/svg+xml', 'svg'],
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
  ['text/csv', 'csv'],
])

export interface ResultContentOptions {
  /** The upstream tool's name, for the output schema message. */
  tool: string
  /** The tool's `outputSchema`, when its listing gave one. */
  outputSchema?: UpstreamTool['outputSchema']
  /** The asset store; a test passes a temporary folder. */
  assetsDir?: string
}

type McpCallResult = CallToolResult | CompatibilityCallToolResult
/** Any JSON value a tool returns beside its content (SEP-2106). */
type StructuredContent = CallToolResult['structuredContent']

export async function agentResultOf(result: McpCallResult, options: ResultContentOptions): Promise<AgentToolResult> {
  if (!('content' in result) || !Array.isArray(result.content)) return { ok: true, text: JSON.stringify(result.toolResult, null, 2) ?? '' }
  const isError = result.isError === true
  if (options.outputSchema && !isError) {
    const refusal = structuredContentRefusal(options.tool, options.outputSchema, result.structuredContent)
    if (refusal) return refusal
  }
  const mapping = new ContentMapping(options.assetsDir)
  for (const part of result.content) await mapping.add(part)
  if (result.structuredContent !== undefined) mapping.addStructured(result.structuredContent)
  return mapping.result(!isError)
}

/** The error result for a structured value that does not match its schema, or null when it matches. */
function structuredContentRefusal(tool: string, outputSchema: NonNullable<UpstreamTool['outputSchema']>, value: StructuredContent): AgentToolResult | null {
  if (value === undefined) return outputSchemaMismatch(tool, 'it returned no structured content')
  try {
    const checked = fromJsonSchema(outputSchema)['~standard'].validate(value)
    if ('then' in checked || !checked.issues) return null
    return outputSchemaMismatch(tool, checked.issues.slice(0, 5).map((issue) => issue.message).join('; '))
  } catch (error) {
    return outputSchemaMismatch(tool, `its output schema could not be read (${error instanceof Error ? error.message : String(error)})`)
  }
}

function outputSchemaMismatch(tool: string, detail: string): AgentToolResult {
  return { ok: false, text: `\`${tool}\` returned data that does not match its output schema: ${detail.slice(0, 500)}` }
}

/**
 * The SDK checks `structuredContent` itself when its session listed the tool,
 * and throws. That is the same refusal as ours: a server's data error, not a
 * broken session.
 */
export function outputSchemaRefusal(tool: string, error: ProtocolError): AgentToolResult | null {
  const message = error.message
  if (message.includes('has an output schema but did not return structured content')) return outputSchemaMismatch(tool, 'it returned no structured content')
  const detail = /(?:does not match the tool's output schema|Failed to validate structured content): ?(.*)$/s.exec(message)
  return detail ? outputSchemaMismatch(tool, detail[1]) : null
}

/** The base64 length past which a payload is larger than `bytes` once decoded. */
function base64Limit(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

class ContentMapping {
  private readonly texts: string[] = []
  private readonly images: AgentToolImage[] = []
  private imageBytes = 0
  private imageCount = 0
  private audioCount = 0
  private files = 0
  private fileBytes = 0

  constructor(private readonly assetsDir: string | undefined) {}

  async add(part: ContentBlock): Promise<void> {
    if (part.type === 'text') this.texts.push(part.text)
    else if (part.type === 'image') await this.addImage(`image ${++this.imageCount}`, typeOf(part.mimeType), part.data)
    else if (part.type === 'audio') await this.addAudio(`audio ${++this.audioCount}`, typeOf(part.mimeType), part.data)
    else if (part.type === 'resource_link') {
      // F1 adds the read tool (§11.2) and its sentence to this line.
      const type = part.mimeType ? ` (${part.mimeType})` : ''
      this.texts.push(`Resource link: ${part.title ?? part.name} <${part.uri}>${type}`)
    } else if (part.type === 'resource') {
      const resource = part.resource
      if ('text' in resource) this.texts.push(`Resource ${resource.uri}:\n${resource.text}`)
      else await this.addBlob(oneLine(resource.uri), typeOf(resource.mimeType), resource.blob)
    } else {
      // A content type of a later revision.
      // SAFETY: every known type is handled above, so this part's `type` is a string the SDK's union does not name.
      const type = (part as { type: string }).type
      this.texts.push(leftOutLine(`a part of type ${oneLine(String(type)).slice(0, 40)}. Solus does not read this content type.`))
    }
  }

  /** `structuredContent` beside the text parts, unless a text part is already its JSON (the specification asks a server to send both). */
  addStructured(value: StructuredContent): void {
    const json = JSON.stringify(value)
    if (this.texts.some((text) => sameJson(text, json))) return
    this.texts.push(JSON.stringify(value, null, 2))
  }

  result(ok: boolean): AgentToolResult {
    let text = this.texts.join('\n\n')
    if (text.length > MAX_RESULT_TEXT_CHARS) {
      const cut = text.length - MAX_RESULT_TEXT_CHARS
      text = `${text.slice(0, MAX_RESULT_TEXT_CHARS)}\n\n${leftOutLine(`the last ${cut.toLocaleString('en-US')} characters of text. A result sends at most ${MAX_RESULT_TEXT_CHARS.toLocaleString('en-US')} characters.`)}`
    }
    const mapped: AgentToolResult = { ok, text }
    if (this.images.length) mapped.images = this.images
    return mapped
  }

  private async addImage(label: string, mimeType: string, data: string): Promise<void> {
    const imageType = agentImageType(mimeType)
    if (!imageType) return this.saveLeftOut(label, mimeType, data, 'is not a type the agent can see (PNG, JPEG, WebP, or GIF)')
    if (data.length > base64Limit(MAX_RESULT_FILE_BYTES)) return this.tooLarge(label, mimeType)
    let bytes: Buffer = Buffer.from(data, 'base64')
    if (rasterImageMimeOf(bytes) !== imageType) {
      this.texts.push(leftOutLine(`${label} (${mimeType}). Its bytes are not that image type.`))
      return
    }
    if (imageType === 'image/png') {
      try {
        bytes = await downscalePng(bytes, MAX_AGENT_TOOL_IMAGE_EDGE)
      } catch {
        this.texts.push(leftOutLine(`${label} (image/png). It does not decode as a PNG.`))
        return
      }
    }
    let limit: string | null = null
    if (this.images.length >= MAX_TOOL_RESULT_IMAGES) limit = `A result sends at most ${MAX_TOOL_RESULT_IMAGES} images`
    else if (bytes.length > MAX_AGENT_TOOL_IMAGE_BYTES) limit = `An image sent to the agent may be at most ${formatByteSize(MAX_AGENT_TOOL_IMAGE_BYTES)}`
    else if (this.imageBytes + bytes.length > MAX_RESULT_IMAGE_TOTAL_BYTES) limit = `The images of one result may be at most ${formatByteSize(MAX_RESULT_IMAGE_TOTAL_BYTES)} together`
    if (limit) return this.saveFile(label, mimeType, bytes, RASTER_EXTENSION[imageType], limit)
    this.imageBytes += bytes.length
    this.images.push({ mimeType: imageType, data: bytes.toString('base64') })
  }

  private async addAudio(label: string, mimeType: string, data: string): Promise<void> {
    if (data.length > base64Limit(MAX_RESULT_FILE_BYTES)) return this.tooLarge(label, mimeType)
    const bytes = Buffer.from(data, 'base64')
    const extension = audioAssetExtension(mimeType, bytes)
    if (!extension) return this.saveFile(label, mimeType, bytes, 'bin', 'It is not an audio type Solus plays, or its bytes are not that type')
    const path = await this.store(label, mimeType, bytes, extension)
    if (path) this.texts.push(audioLine(mimeType, bytes.length, path))
  }

  private async addBlob(uri: string, mimeType: string, data: string): Promise<void> {
    if (mimeType.startsWith('image/')) return this.addImage(`resource ${uri}`, mimeType, data)
    if (mimeType.startsWith('audio/')) return this.addAudio(`resource ${uri}`, mimeType, data)
    if (data.length > base64Limit(MAX_RESULT_FILE_BYTES)) return this.tooLarge(`resource ${uri}`, mimeType)
    const bytes = Buffer.from(data, 'base64')
    const path = await this.store(`resource ${uri}`, mimeType, bytes, FILE_EXTENSION.get(mimeType) ?? 'bin')
    if (path) this.texts.push(`Resource ${uri} (${mimeType}, ${formatByteSize(bytes.length)}) saved at ${path}`)
  }

  /** A part the agent cannot take as it is, saved for it to read, with the reason. */
  private async saveLeftOut(label: string, mimeType: string, data: string, reason: string): Promise<void> {
    if (data.length > base64Limit(MAX_RESULT_FILE_BYTES)) return this.tooLarge(label, mimeType)
    await this.saveFile(label, mimeType, Buffer.from(data, 'base64'), FILE_EXTENSION.get(mimeType) ?? 'bin', `It ${reason}`)
  }

  private async saveFile(label: string, mimeType: string, bytes: Buffer, extension: string, reason: string): Promise<void> {
    const path = await this.store(label, mimeType, bytes, extension)
    if (path) this.texts.push(leftOutLine(`${label} (${mimeType}, ${formatByteSize(bytes.length)}). ${reason}. Saved at ${path}`))
  }

  private tooLarge(label: string, mimeType: string): void {
    this.texts.push(leftOutLine(`${label} (${mimeType}). A saved file may be at most ${formatByteSize(MAX_RESULT_FILE_BYTES)}.`))
  }

  /** Save bytes in the asset store under their content hash; null, with a line, past a file limit. */
  private async store(label: string, mimeType: string, bytes: Buffer, extension: string): Promise<string | null> {
    let limit: string | null = null
    if (bytes.length > MAX_RESULT_FILE_BYTES) limit = `A saved file may be at most ${formatByteSize(MAX_RESULT_FILE_BYTES)}`
    else if (this.files >= MAX_RESULT_FILES) limit = `A result saves at most ${MAX_RESULT_FILES} files`
    else if (this.fileBytes + bytes.length > MAX_RESULT_FILE_TOTAL_BYTES) limit = `The saved files of one result may be at most ${formatByteSize(MAX_RESULT_FILE_TOTAL_BYTES)} together`
    if (limit) {
      this.texts.push(leftOutLine(`${label} (${mimeType}, ${formatByteSize(bytes.length)}). ${limit}.`))
      return null
    }
    this.files++
    this.fileBytes += bytes.length
    try {
      const stored = await writeAssetBytes(bytes, extension, { assetsDir: this.assetsDir })
      return await agentReadablePath(storedAssetPath(stored.id, this.assetsDir))
    } catch (error) {
      this.texts.push(leftOutLine(`${label} (${mimeType}, ${formatByteSize(bytes.length)}). The host could not save it: ${error instanceof Error ? oneLine(error.message) : 'unknown error'}.`))
      return null
    }
  }
}

/** A declared media type as the lines name it: lowercase, without parameters, or `application/octet-stream` when it is not a media type. */
function typeOf(declared: string | undefined): string {
  const type = (declared ?? '').toLowerCase().split(';', 1)[0].trim()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(type) ? type : 'application/octet-stream'
}

/** A server's URI as one short line of a note. */
function oneLine(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

function agentImageType(mimeType: string): AgentToolImageType | null {
  return AGENT_IMAGE_TYPES.find((type) => type === mimeType) ?? null
}

function sameJson(text: string, json: string): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === json
  } catch {
    return false
  }
}

/**
 * One read that ran for several accounts (§13.3 of mcp-integrations.md): the
 * parts under their account's heading, and the images of all of them within
 * the limits of one result.
 */
export function mergedAccountResults(parts: Array<{ label: string; result: AgentToolResult }>): AgentToolResult {
  const images: AgentToolImage[] = []
  let imageBytes = 0
  const texts = parts.map(({ label, result }) => {
    const lines = [`## ${label}`, result.text]
    for (const image of result.images ?? []) {
      const bytes = Math.floor(image.data.length * 3 / 4)
      if (images.length >= MAX_TOOL_RESULT_IMAGES) lines.push(leftOutLine(`an image of ${label}. A result sends at most ${MAX_TOOL_RESULT_IMAGES} images.`))
      else if (imageBytes + bytes > MAX_RESULT_IMAGE_TOTAL_BYTES) lines.push(leftOutLine(`an image of ${label}. The images of one result may be at most ${formatByteSize(MAX_RESULT_IMAGE_TOTAL_BYTES)} together.`))
      else {
        images.push(image)
        imageBytes += bytes
      }
    }
    return lines.join('\n')
  })
  const merged: AgentToolResult = { ok: parts.some(({ result }) => result.ok), text: texts.join('\n\n') }
  if (images.length) merged.images = images
  return merged
}
