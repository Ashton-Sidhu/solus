import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeTurnNormalizer } from '@solus/server/execution/agents/claude/claude-event-normalizer'
import { parseJsonlLine } from '@solus/server/execution/agents/claude/claude-session-helpers'
import { claudeToolResponse } from '@solus/server/execution/agents/claude/claude-tool-adapter'
import { CodexTurnNormalizer } from '@solus/server/execution/agents/codex/codex-event-normalizer'
import { codexToolContentItems } from '@solus/server/execution/agents/codex/codex-tool-adapter'
import { codexItemToMessage } from '@solus/server/execution/agents/codex/codex-utils'
import { agentToolImage } from '@solus/server/execution/agents/tools/agent-tool'
import { writeAssetBytes } from '@solus/server/data/assets/assets'
import { storedAssetPath } from '@solus/server/data/assets/asset-paths'
import { MAX_TOOL_RESULT_IMAGES, storePromptImages, storeToolResultImages } from '@solus/server/data/assets/transcript-images'
import type { ClaudeEvent } from '@solus/contracts/claude-types'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

/**
 * Tool-result and prompt images leave the transcript as asset references
 * (plan: the wire carries ids, the asset store carries pixels). A client must
 * never receive base64 in a session event or a history page, and a reload must
 * find the asset it stored the first time instead of writing another.
 */

/** A PNG header of the given size, unique per `seed` so each test owns its asset. */
function png(width: number, height: number, seed: number): Buffer {
  const header = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'latin1')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return Buffer.concat([header, Buffer.from(`seed-${seed}-${Math.random()}`)])
}

const assetsDir = () => join(process.env.SOLUS_DATA_DIR!, 'assets')
const assetCount = () => (existsSync(assetsDir()) ? readdirSync(assetsDir()).length : 0)

function claudeToolResult(content: unknown[]): ClaudeEvent {
  // SAFETY: the SDK's user event, as the CLI streams it for a tool result.
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content }] } } as unknown as ClaudeEvent
}

describe('tool result images', () => {
  test('a Claude tool result image becomes a stored ref and no base64 reaches the event', () => {
    const bytes = png(920, 2000, 1)
    const base64 = bytes.toString('base64')
    const events = new ClaudeTurnNormalizer().push(claudeToolResult([
      { type: 'text', text: 'Took a screenshot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
    ]))
    const result = events.find((event) => event.type === 'tool_result')
    expect(result?.type === 'tool_result' && result.content).toBe('Took a screenshot')
    const ref = result?.type === 'tool_result' ? result.toolImages?.[0] : undefined
    expect(ref).toMatchObject({ mimeType: 'image/png', width: 920, height: 2000 })
    expect(readFileSync(storedAssetPath(ref!.assetId))).toEqual(bytes)
    expect(JSON.stringify(events)).not.toContain(base64)
  })

  test('only allowed raster types are stored, at most eight per call', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')
    expect(storeToolResultImages([{ type: 'image', data: svg, mimeType: 'image/svg+xml' }])).toBeUndefined()
    // A label cannot make non-image bytes an image.
    expect(storeToolResultImages([{ type: 'image', data: svg, mimeType: 'image/png' }])).toBeUndefined()
    const many = Array.from({ length: 10 }, (_, index) => ({ type: 'image', data: png(1, 1, 100 + index).toString('base64'), mimeType: 'image/png' }))
    expect(storeToolResultImages(many)).toHaveLength(MAX_TOOL_RESULT_IMAGES)
  })

  test('reloading a Claude transcript reuses the stored asset', () => {
    const bytes = png(10, 20, 2)
    const line = JSON.stringify({
      type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: [
        { type: 'text', text: 'ok' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } },
      ] }] },
    })
    const first = parseJsonlLine(line)
    const before = assetCount()
    const second = parseJsonlLine(line)
    expect(assetCount()).toBe(before)
    expect(second?.toolImages).toEqual(first?.toolImages)
    expect(second?.toolImages?.[0]).toMatchObject({ width: 10, height: 20 })
    expect(JSON.stringify(second)).not.toContain(bytes.toString('base64'))
  })

  test('Codex MCP results keep their text without the image bytes', () => {
    const bytes = png(3, 4, 3)
    const base64 = bytes.toString('base64')
    const item = {
      type: 'mcpToolCall', id: 'mcp-1', server: 'solus', tool: 'shot', status: 'completed', arguments: {},
      result: { content: [{ type: 'text', text: 'shot' }, { type: 'image', data: base64, mimeType: 'image/png' }], structuredContent: null },
    }
    const events = new CodexTurnNormalizer({ planMode: false }).push({ method: 'item/completed', params: { item } })
    const update = events.find((event): event is Extract<NormalizedEvent, { type: 'tool_call_update' }> => event.type === 'tool_call_update')
    expect(update?.toolImages?.[0]).toMatchObject({ mimeType: 'image/png', width: 3, height: 4 })
    expect(JSON.stringify(events)).not.toContain(base64)
    expect(update?.content).toContain('shot')
    // History reads the same item into the same ref.
    expect(codexItemToMessage(item, 0)?.toolImages).toEqual(update?.toolImages)
  })
})

describe('device_screenshot', () => {
  // The device manager stores the PNG it captured (`storeImage`), then the tool
  // sends the same bytes to the agent. The ref the transcript carries is that
  // asset, for either provider, and no second file is written.
  test('its tool row carries the screenshot asset it already stored', async () => {
    const shot = png(390, 844, 4)
    const stored = await writeAssetBytes(shot, 'png')
    const image = agentToolImage(shot)!
    const text = `Screenshot. Saved as asset ${stored.id}.`
    const before = assetCount()

    const claude = new ClaudeTurnNormalizer().push(claudeToolResult(claudeToolResponse({ ok: true, text, image }).content))
    const claudeResult = claude.find((event) => event.type === 'tool_result')
    expect(claudeResult?.type === 'tool_result' && claudeResult.toolImages).toEqual([{ assetId: stored.id, mimeType: 'image/png', width: 390, height: 844 }])

    const codex = new CodexTurnNormalizer({ planMode: false }).push({ method: 'item/completed', params: { item: {
      type: 'dynamicToolCall', id: 'dyn-1', namespace: 'solus', tool: 'device_screenshot', status: 'completed', arguments: {},
      contentItems: codexToolContentItems(text, image), success: true,
    } } })
    const codexUpdate = codex.find((event) => event.type === 'tool_call_update')
    expect(codexUpdate?.type === 'tool_call_update' && codexUpdate.toolImages?.[0].assetId).toBe(stored.id)
    expect(assetCount()).toBe(before)
  })
})

describe('prompt images in history', () => {
  test('a history page names stored files, not data URLs', () => {
    const bytes = png(8, 8, 5)
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`
    const line = JSON.stringify({
      type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:00Z',
      message: { content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } }] },
    })
    // The provider reader is unchanged: it still decodes the inline image.
    const read = parseJsonlLine(line)!
    expect(read.imageAttachments).toEqual([{ mimeType: 'image/png', dataUrl }])

    const [message] = storePromptImages([read])
    expect(message.imageAttachments).toBeUndefined()
    expect(message.imageAttachmentRefs).toHaveLength(1)
    expect(message.imageAttachmentRefs![0].mimeType).toBe('image/png')
    expect(readFileSync(message.imageAttachmentRefs![0].hostPath)).toEqual(bytes)
    expect(JSON.stringify(message)).not.toContain('base64')
  })

  test('an image the store refuses stays a legacy data URL', () => {
    const dataUrl = `data:image/heic;base64,${Buffer.from('not a raster image').toString('base64')}`
    const legacy: SessionLoadMessage = { role: 'user', content: '', imageAttachments: [{ mimeType: 'image/heic', dataUrl }], timestamp: 0 }
    const [message] = storePromptImages([legacy])
    expect(message.imageAttachments).toEqual([{ mimeType: 'image/heic', dataUrl }])
    expect(message.imageAttachmentRefs).toBeUndefined()
  })
})
