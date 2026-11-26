import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { ProtocolError, ProtocolErrorCode, type CallToolResult } from '@modelcontextprotocol/client'
import type { ClaudeEvent } from '@solus/contracts/claude-types'
import { createAssetUrl, serveAssetToken } from '@solus/server/data/assets/assets'
import { toolResultMedia } from '@solus/server/data/assets/tool-result-media'
import { ClaudeTurnNormalizer } from '@solus/server/execution/agents/claude/claude-event-normalizer'
import { mcpToolResult } from '@solus/server/execution/agents/tools/agent-tool-endpoint'
import { codexToolContentItems } from '@solus/server/execution/agents/codex/codex-tool-adapter'
import { upstreamToolToAgentTool } from '@solus/server/integrations/integration-tools'
import {
  agentResultOf,
  MAX_RESULT_TEXT_CHARS,
  mergedAccountResults,
  outputSchemaRefusal,
} from '@solus/server/integrations/result-content'

/**
 * The mapper of docs/plans/mcp-first-class.md §6. The rule it keeps: no part
 * of an MCP tool result is lost silently. A part reaches the agent as text, as
 * an image both providers send, as a saved file's path, or as a `[Left out: …]`
 * line that names the limit; and the person sees the same images, a player for
 * audio, and the notes.
 */

const assetsDir = () => mkdtempSync(join(tmpdir(), 'solus-result-content-'))

let seed = 0
/** A PNG header small enough that nothing scales it; each call has its own bytes. */
function png(): Buffer {
  const header = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'latin1')
  header.writeUInt32BE(4, 16)
  header.writeUInt32BE(4, 20)
  return Buffer.concat([header, Buffer.from(`png-${seed++}`)])
}
const jpeg = (size = 32) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, seed++ % 256), Buffer.from([0xff, 0xd9])])
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(`webp-${seed++}`)])
const mp3 = (size = 64) => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(size, seed++ % 256)])

const image = (bytes: Buffer, mimeType: string) => ({ type: 'image' as const, data: bytes.toString('base64'), mimeType })
const audio = (bytes: Buffer, mimeType = 'audio/mpeg') => ({ type: 'audio' as const, data: bytes.toString('base64'), mimeType })
const map = (result: CallToolResult, options: Partial<Parameters<typeof agentResultOf>[1]> = {}) =>
  agentResultOf(result, { tool: 'search', assetsDir: options.assetsDir ?? assetsDir(), ...options })

function leftOut(text: string): string[] {
  return [...text.matchAll(/^\[Left out: (.+)\]$/gm)].map((match) => match[1])
}

function savedPath(line: string): string {
  return /Saved at (\S+)$/.exec(line)?.[1] ?? /saved at (\S+?)\]?$/.exec(line)?.[1] ?? ''
}

function claudeToolResult(content: unknown[]): ClaudeEvent {
  // SAFETY: the SDK's user event, as the CLI streams it for a tool result.
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content }] } } as unknown as ClaudeEvent
}

describe('images', () => {
  test('three images of three types reach both providers in order', async () => {
    const parts = [png(), jpeg(), webp()]
    const result = await map({ content: [{ type: 'text', text: 'three' }, image(parts[0], 'image/png'), image(parts[1], 'image/jpeg'), image(parts[2], 'image/webp')] })
    expect(result.images?.map((each) => each.mimeType)).toEqual(['image/png', 'image/jpeg', 'image/webp'])
    expect(result.images?.map((each) => each.data)).toEqual(parts.map((bytes) => bytes.toString('base64')))

    // WHY: both providers get the same content (§3 rule 1).
    const claude = mcpToolResult(result).content
    expect(claude.map((block) => block.type)).toEqual(['text', 'image', 'image', 'image'])
    const codex = codexToolContentItems(result.text, result.images)
    expect(codex.map((item) => item.type)).toEqual(['inputText', 'inputImage', 'inputImage', 'inputImage'])
    expect(codex.slice(1).map((item) => item.type === 'inputImage' && item.imageUrl)).toEqual([
      `data:image/png;base64,${parts[0].toString('base64')}`,
      `data:image/jpeg;base64,${parts[1].toString('base64')}`,
      `data:image/webp;base64,${parts[2].toString('base64')}`,
    ])

    // WHY: the person sees each image the agent got, for either provider.
    const claudeEvent = new ClaudeTurnNormalizer().push(claudeToolResult(claude)).find((event) => event.type === 'tool_result')
    expect(claudeEvent?.type === 'tool_result' && claudeEvent.toolImages?.length).toBe(3)
    // The Codex normalizer's side is in transcript-images.test.ts.
  })

  test('a ninth image is a line that names the limit, and its file is saved for the agent', async () => {
    const result = await map({ content: Array.from({ length: 9 }, () => image(png(), 'image/png')) })
    expect(result.images).toHaveLength(8)
    const [line] = leftOut(result.text)
    expect(line).toContain('image 9 (image/png')
    expect(line).toContain('A result sends at most 8 images')
    expect(existsSync(savedPath(line))).toBe(true)
  })

  test('an image past the size of one image, or past the total, names that limit', async () => {
    const large = await map({ content: [image(jpeg(6 * 1024 * 1024), 'image/jpeg')] })
    expect(large.images).toBeUndefined()
    expect(leftOut(large.text)[0]).toContain('An image sent to the agent may be at most 5 MB')

    const three = await map({ content: [1, 2, 3].map(() => image(jpeg(4 * 1024 * 1024), 'image/jpeg')) })
    expect(three.images).toHaveLength(2)
    expect(leftOut(three.text)[0]).toContain('image 3')
    expect(leftOut(three.text)[0]).toContain('at most 10 MB together')
  })

  test('an image whose bytes are not its type is refused, and an SVG is saved as a file', async () => {
    const wrong = await map({ content: [image(Buffer.from('not a png at all'), 'image/png')] })
    expect(wrong.images).toBeUndefined()
    expect(leftOut(wrong.text)).toEqual(['image 1 (image/png). Its bytes are not that image type.'])

    const svg = await map({ content: [image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')] })
    expect(svg.images).toBeUndefined()
    const [line] = leftOut(svg.text)
    expect(line).toContain('is not a type the agent can see')
    expect(savedPath(line).endsWith('.svg')).toBe(true)
  })
})

describe('audio', () => {
  test('audio is an asset, a line with its host path for the agent, and a player for the person', async () => {
    const directory = assetsDir()
    const bytes = mp3()
    const result = await map({ content: [audio(bytes)] }, { assetsDir: directory })
    // WHY: no provider model takes audio in a tool result (§1 item 8), so neither adapter sends it.
    expect(result.images).toBeUndefined()
    expect(mcpToolResult(result).content).toEqual([{ type: 'text', text: result.text }])
    expect(codexToolContentItems(result.text, result.images)).toEqual([{ type: 'inputText', text: result.text }])

    expect(result.text).toMatch(/^\[Audio: audio\/mpeg, 67 B, saved at .+\.mp3\]$/)
    const path = /saved at (.+)\]$/.exec(result.text)![1]
    expect(readdirSync(directory)).toContain(basename(path))
    expect(toolResultMedia(result.text).toolAudio).toEqual([{ assetId: basename(path), mimeType: 'audio/mpeg' }])

    // WHY: the line comes back from each provider's own transcript, so the player survives a reload.
    const claudeEvent = new ClaudeTurnNormalizer().push(claudeToolResult(mcpToolResult(result).content)).find((event) => event.type === 'tool_result')
    expect(claudeEvent?.type === 'tool_result' && claudeEvent.toolAudio).toEqual([{ assetId: basename(path), mimeType: 'audio/mpeg' }])
  })

  test('audio that is not its type is saved as bytes, and audio past the file limit is named', async () => {
    const wrong = await map({ content: [audio(Buffer.from('plain text, not audio'), 'audio/mpeg')] })
    expect(toolResultMedia(wrong.text).toolAudio).toBeUndefined()
    const [line] = leftOut(wrong.text)
    expect(line).toContain('It is not an audio type Solus plays, or its bytes are not that type')
    expect(savedPath(line).endsWith('.bin')).toBe(true)

    const directory = assetsDir()
    const huge = await map({ content: [audio(mp3(11 * 1024 * 1024))] }, { assetsDir: directory })
    expect(leftOut(huge.text)).toEqual(['audio 1 (audio/mpeg). A saved file may be at most 10 MB.'])
    expect(readdirSync(directory)).toEqual([])
  })

  test('a ninth saved file names the file limit', async () => {
    const result = await map({ content: Array.from({ length: 9 }, () => audio(mp3())) })
    expect(toolResultMedia(result.text).toolAudio).toHaveLength(8)
    expect(leftOut(result.text)).toEqual([expect.stringContaining('A result saves at most 8 files')])
  })
})

describe('resources', () => {
  test('a resource link is a line with its name, URI, and type', async () => {
    const result = await map({ content: [{ type: 'resource_link', name: 'Spec', uri: 'file:///docs/spec.md', mimeType: 'text/markdown' }] })
    expect(result.text).toBe('Resource link: Spec <file:///docs/spec.md> (text/markdown)')
    // WHY: the read tool arrives with F1; until then the line must not name a tool the agent cannot call.
    expect(result.text).not.toContain('read_integration_resource')
  })

  test('a text resource keeps its URI, and a blob resource of each kind lands where its type goes', async () => {
    const text = await map({ content: [{ type: 'resource', resource: { uri: 'note://1', text: 'hello' } }] })
    expect(text.text).toBe('Resource note://1:\nhello')

    const picture = png()
    const blobs = await map({ content: [
      { type: 'resource', resource: { uri: 'img://1', mimeType: 'image/png', blob: picture.toString('base64') } },
      { type: 'resource', resource: { uri: 'snd://1', mimeType: 'audio/mpeg', blob: mp3().toString('base64') } },
      { type: 'resource', resource: { uri: 'doc://1', mimeType: 'application/pdf', blob: Buffer.from('%PDF-1.7').toString('base64') } },
    ] })
    expect(blobs.images).toEqual([{ mimeType: 'image/png', data: picture.toString('base64') }])
    expect(toolResultMedia(blobs.text).toolAudio).toHaveLength(1)
    expect(blobs.text).toMatch(/^Resource doc:\/\/1 \(application\/pdf, 8 B\) saved at .+\.pdf$/m)
  })

  test('a content type Solus does not know is named, not dropped', async () => {
    // SAFETY: a content type of a later revision, which the SDK's types do not list.
    const result = await map({ content: [{ type: 'hologram' } as unknown as CallToolResult['content'][number]] })
    expect(leftOut(result.text)).toEqual(['a part of type hologram. Solus does not read this content type.'])
  })
})

describe('structured content', () => {
  const outputSchema = { type: 'object' as const, properties: { count: { type: 'number' } }, required: ['count'] }

  test('a result with text and structured content keeps both', async () => {
    const result = await map({ content: [{ type: 'text', text: 'Two issues.' }], structuredContent: { count: 2 } })
    expect(result.text).toBe('Two issues.\n\n{\n  "count": 2\n}')
    // WHY: the specification asks a server to send its JSON as text too; the agent reads it once.
    const echoed = await map({ content: [{ type: 'text', text: '{"count":2}' }], structuredContent: { count: 2 } })
    expect(echoed.text).toBe('{"count":2}')
    // WHY: modern servers can return any JSON value, including null and a number.
    expect((await map({ content: [], structuredContent: null })).text).toBe('null')
    expect((await map({ content: [], structuredContent: 7 })).text).toBe('7')
  })

  test('structured content that does not match the output schema is an error that says so', async () => {
    const result = await map({ content: [{ type: 'text', text: 'ok' }], structuredContent: { count: 'two' } }, { outputSchema })
    expect(result.ok).toBe(false)
    expect(result.text).toStartWith('`search` returned data that does not match its output schema: ')
    expect(result.text).toContain('count')

    const missing = await map({ content: [{ type: 'text', text: 'ok' }] }, { outputSchema })
    expect(missing).toEqual({ ok: false, text: '`search` returned data that does not match its output schema: it returned no structured content' })

    expect(await map({ content: [], structuredContent: { count: 2 } }, { outputSchema })).toEqual({ ok: true, text: '{\n  "count": 2\n}' })
    // WHY: a tool error carries no structured result to check.
    expect(await map({ content: [{ type: 'text', text: 'nope' }], isError: true }, { outputSchema })).toEqual({ ok: false, text: 'nope' })
  })

  test('the SDK refusal of a mismatch reads the same as the gateway check', () => {
    const mismatch = new ProtocolError(ProtocolErrorCode.InvalidParams, "Structured content does not match the tool's output schema: data/count must be number")
    expect(outputSchemaRefusal('search', mismatch)).toEqual({ ok: false, text: '`search` returned data that does not match its output schema: data/count must be number' })
    const absent = new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Tool search has an output schema but did not return structured content')
    expect(outputSchemaRefusal('search', absent)?.ok).toBe(false)
    expect(outputSchemaRefusal('search', new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown tool'))).toBeNull()
  })

  test('a tool with a short output schema says what it returns', () => {
    const tool = upstreamToolToAgentTool({ id: 'i', name: 'Linear', slug: 'linear' }, { name: 'count', description: 'Count issues.', inputSchema: { type: 'object' }, outputSchema }, { call: async () => ({ ok: true, text: '' }) })
    expect(tool.description).toBe(`Linear: Count issues.\nReturns JSON: \`${JSON.stringify(outputSchema)}\``)
  })
})

describe('text and merges', () => {
  test('text past the limit is cut and the cut is named', async () => {
    const result = await map({ content: [{ type: 'text', text: 'x'.repeat(MAX_RESULT_TEXT_CHARS + 10) }] })
    expect(result.text.startsWith('x'.repeat(MAX_RESULT_TEXT_CHARS))).toBe(true)
    expect(leftOut(result.text)).toEqual(['the last 10 characters of text. A result sends at most 200,000 characters.'])
  })

  test('a read across two accounts keeps the images of both', () => {
    const one = { mimeType: 'image/png' as const, data: png().toString('base64') }
    const two = { mimeType: 'image/jpeg' as const, data: jpeg().toString('base64') }
    const merged = mergedAccountResults([
      { label: 'work', result: { ok: true, text: 'a', images: [one] } },
      { label: 'home', result: { ok: false, text: 'b', images: [two] } },
    ])
    expect(merged).toEqual({ ok: true, text: '## work\na\n\n## home\nb', images: [one, two] })
  })
})

describe('what the person sees', () => {
  test('a note keeps its limit and loses the host path; a line that names no stored audio is no player', () => {
    const media = toolResultMedia([
      '[Left out: image 9 (image/png, 1 KB). A result sends at most 8 images. Saved at /host/data/assets/abc.png]',
      '[Audio: audio/mpeg, 1 KB, saved at /etc/passwd]',
      `[Audio: audio/mpeg, 1 KB, saved at /x/${'a'.repeat(64)}.png]`,
    ].join('\n'))
    expect(media.toolLeftOut).toEqual(['image 9 (image/png, 1 KB). A result sends at most 8 images. The agent can read the saved file on the host.'])
    expect(media.toolAudio).toBeUndefined()
  })

  test('a stored audio asset plays in place with its audio type', async () => {
    const directory = assetsDir()
    const result = await map({ content: [audio(mp3())] }, { assetsDir: directory })
    const assetId = basename(/saved at (.+)\]$/.exec(result.text)![1])
    const secret = Buffer.alloc(32, 7)
    const { relativeUrl } = await createAssetUrl(undefined, { assetId }, { secret, assetsDir: directory })
    const response = await serveAssetToken(relativeUrl.slice('/api/assets/'.length), { method: 'GET' }, { secret })
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('audio/mpeg')
    expect(response.headers.get('Content-Disposition')).toBeNull()
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})
