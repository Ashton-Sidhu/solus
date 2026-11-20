import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { Message } from '@solus/contracts/types'
import {
  TOOL_CALL_FACTS,
  TOOL_GALLERY_LIMIT,
  TOOL_OUTPUT_PLACES,
  toolGalleryImages,
  toolStripChips,
  turnToolGallery,
} from '@solus/client-core/tool-outputs'
import { integrationAgentToolLabel, toolServerName } from '@solus/client-core/mcp-tool-label'
import { turnGallery } from '@solus/workspace-ui/components/conversation/lib/turn-images'

const asset = (letter: string, extension = 'png') => `${letter.repeat(64)}.${extension}`
const image = (letter: string) => ({ assetId: asset(letter), mimeType: 'image/png' })
const call = (id: string, fields: Partial<Message> = {}): Message => ({
  id, role: 'tool', content: '', timestamp: 1, toolStatus: 'completed', toolName: 'mcp__grafana__render_panels', ...fields,
})

describe('the rule for the visible outputs of a tool call', () => {
  test('every output field a tool call carries has a place, so a new one cannot ship without a choice', () => {
    // WHY: a tool output that has no place shows only inside the open tool
    // line, under three folds, and the person never learns it exists. Reading
    // the contract's Message type catches a field added to the wire before any
    // client draws it.
    const source = readFileSync(new URL('../../packages/contracts/src/types.ts', import.meta.url), 'utf8')
    const body = source.slice(source.indexOf('export interface Message {'))
    const message = body.slice(0, body.indexOf('\n}\n'))
    const toolFields = [...message.matchAll(/^ {2}(tool[A-Za-z]*)\??:/gm)].map((match) => match[1])
    expect(toolFields.length).toBeGreaterThan(5)
    const unplaced = toolFields.filter((field) => !(field in TOOL_OUTPUT_PLACES) && !(TOOL_CALL_FACTS as readonly string[]).includes(field))
    expect(unplaced).toEqual([])
  })

  test('images go to the gallery and every other output a closed line hides goes to the strip', () => {
    expect(TOOL_OUTPUT_PLACES.toolImages).toBe('gallery')
    expect(TOOL_OUTPUT_PLACES.toolAudio).toBe('strip')
    expect(TOOL_OUTPUT_PLACES.toolLeftOut).toBe('strip')
    const tool = call('t1', {
      toolName: 'mcp__solus__elevenlabs__text_to_speech',
      toolImages: [image('a')],
      toolAudio: [{ assetId: asset('b', 'mp3'), mimeType: 'audio/mpeg' }],
      toolLeftOut: ['Panel "saturation": past the 5 MB limit', 'Panel "errors": past the 5 MB limit'],
    })
    expect(toolGalleryImages(tool).map((entry) => entry.href)).toEqual([`asset://${asset('a')}`])
    expect(toolStripChips([tool])).toEqual([
      { kind: 'audio', key: `audio:t1:${asset('b', 'mp3')}`, toolId: 't1', server: 'elevenlabs', format: 'MP3' },
      { kind: 'left-out', key: 'left-out:t1', toolId: 't1', count: 2 },
    ])
  })

  test('a running call gives no gallery image and no chip, so the stream does no work for them', () => {
    const running = call('t1', { toolStatus: 'running', toolImages: [image('a')], toolLeftOut: ['x'] })
    expect(toolGalleryImages(running)).toEqual([])
    expect(toolStripChips([running])).toEqual([])
  })

  test('a browser capture is in the gallery once, as its capture card', () => {
    // WHY: browser_snapshot also returns a scaled copy of the page to the agent.
    // The capture card already shows the page, so the copy would show it twice.
    expect(toolGalleryImages(call('t1', { toolName: 'mcp__solus__browser_snapshot', toolImages: [image('a')] }))).toEqual([])
    expect(toolGalleryImages(call('t2', { toolName: 'device_screenshot', toolImages: [image('a')] }))).toHaveLength(1)
  })

  test('many images: the gallery shows the limit in call order, and the last card opens the rest', () => {
    const tools = [0, 1, 2].map((index) => call(`t${index}`, {
      toolImages: Array.from({ length: 4 }, (_, n) => image(String.fromCharCode(97 + index * 4 + n))),
    }))
    // The same picture from a later call is shown once.
    tools.push(call('t3', { toolImages: [image('a')] }))
    const gallery = turnToolGallery(tools)
    expect(gallery.shown).toHaveLength(TOOL_GALLERY_LIMIT)
    expect(gallery.shown.map((entry) => entry.toolId)).toEqual(['t0', 't0', 't0', 't0', 't1', 't1', 't1', 't1'])
    expect(gallery.all).toHaveLength(12)
    expect(gallery.moreCount).toBe(4)
  })
})

describe('the turn gallery on desktop and web', () => {
  test('tool images join the replies and captures at the time of their call', () => {
    const before = { id: 'r1', role: 'assistant', content: '![chart](/tmp/before.png)', timestamp: 10 } satisfies Message
    const capture = { id: 'c1', role: 'assistant', content: '', timestamp: 30, browserSnapshot: { assetId: asset('c'), browserPageId: 'p', url: 'u', title: 't', viewport: 'v', appearance: 'light', elementCount: 0, consoleErrors: 0, capturedAt: 30 } } satisfies Message
    const tool = call('t1', { timestamp: 20, toolImages: [image('a'), image('b')] })
    const gallery = turnGallery([before, capture], [tool])
    expect(gallery.entries.map((entry) => entry.kind === 'message' ? entry.key : `${entry.image.label}`)).toEqual([
      'r1', 'grafana image 1', 'grafana image 2', 'c1',
    ])
    expect(gallery.moreCount).toBe(0)
  })
})

describe('readable labels for the Solus tools of the MCP program', () => {
  test('a resource read names its server and resource, as the other MCP rows do', () => {
    // WHY: the row showed `mcp__solus__read_integration_resource`, a name no person reads.
    expect(integrationAgentToolLabel('mcp__solus__read_integration_resource', '{"server":"linear","uri":"issue://ENG-412"}')).toBe('linear · read issue://ENG-412')
    expect(integrationAgentToolLabel('read_integration_resource')).toBe('Read resource')
    expect(integrationAgentToolLabel('mcp__solus__list_integration_resources', '{"server":"linear"}')).toBe('linear · list resources')
    expect(integrationAgentToolLabel('list_integration_resources', '{}')).toBe('List resources')
    expect(integrationAgentToolLabel('mcp__solus__watch_integration_resource', '{"server":"linear","uri":"issue://1","watching":true}')).toBe('linear · watch issue://1')
    expect(integrationAgentToolLabel('watch_integration_resource', '{"server":"linear","uri":"issue://1","watching":false}')).toBe('linear · stop watching issue://1')
    expect(integrationAgentToolLabel('mcp__solus__connect_integration', '{"service":"Notion"}')).toBe('Connect Notion')
    expect(integrationAgentToolLabel('connect_integration', '{"custom":true}')).toBe('Connect a server')
    expect(integrationAgentToolLabel('mcp__linear__create_issue')).toBeNull()
  })

  test('the strip names the server of a call', () => {
    expect(toolServerName('mcp__solus__grafana__render_panels')).toBe('grafana')
    expect(toolServerName('read_integration_resource', '{"server":"linear","uri":"x"}')).toBe('linear')
    expect(toolServerName('Bash')).toBeNull()
  })
})
