import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { Message } from '@solus/contracts/types'
import {
  TOOL_CALL_FACTS,
  TOOL_OUTPUT_PLACES,
  TOOL_STRIP_IMAGE_LIMIT,
  hasToolStrip,
  openLineAudio,
  openLineLeftOut,
  toolStrip,
} from '@solus/client-core/tool-outputs'
import { integrationAgentToolLabel, toolServerName } from '@solus/client-core/mcp-tool-label'
import { hasGallerySlides } from '@solus/workspace-ui/components/conversation/lib/turn-images'
import { threadTurnImages } from '../../apps/mobile/solus-core/features/threads/thread-turn-images'
import type { ToolItem } from '../../apps/mobile/solus-core/features/conversation/lib/tool-item'
import { toolCallOutputs } from '../../apps/mobile/solus-core/features/threads/thread-work-log-presentation'

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

  test('tool images, audio, and left-out notes go to the strip; the strip shows the thumbnails first', () => {
    // WHY: the maintainer's rule is that only the final output of a turn goes
    // to its image gallery. What a tool returned is work: it shows under the
    // row that folds it, so a folded turn still shows that it exists.
    expect(TOOL_OUTPUT_PLACES.toolImages).toBe('strip')
    expect(TOOL_OUTPUT_PLACES.toolAudio).toBe('strip')
    expect(TOOL_OUTPUT_PLACES.toolLeftOut).toBe('strip')
    const speech = call('t1', {
      toolName: 'mcp__solus__elevenlabs__text_to_speech',
      toolAudio: [{ assetId: asset('b', 'mp3'), mimeType: 'audio/mpeg' }],
      toolLeftOut: ['Panel "saturation": past the 5 MB limit', 'Panel "errors": past the 5 MB limit'],
    })
    const chart = call('t2', { toolImages: [image('a')] })
    const strip = toolStrip([speech, chart])
    expect(strip.thumbnails.map((entry) => [entry.toolId, entry.image.href, entry.image.label])).toEqual([['t2', `asset://${asset('a')}`, 'grafana image 1']])
    expect(strip.chips).toEqual([
      { kind: 'audio', key: `audio:t1:${asset('b', 'mp3')}`, toolId: 't1', server: 'elevenlabs', format: 'MP3' },
      { kind: 'left-out', key: 'left-out:t1', toolId: 't1', count: 2 },
    ])
  })

  test('tool images stay out of the turn gallery on desktop, web, and mobile', () => {
    const chart = call('t1', { toolImages: [image('a')] })
    expect(hasGallerySlides([chart])).toBe(false)
    const mobileTool: ToolItem = {
      kind: 'tool', id: 't1', toolId: 't1', toolName: 'mcp__grafana__render_panels', input: null, status: 'completed',
      errorHead: null, childCount: 0, subagent: null, report: null, images: [image('a')],
    }
    expect(threadTurnImages([mobileTool])).toEqual([])
  })

  test('a running call gives no thumbnail and no chip, so the stream does no work for them', () => {
    const running = call('t1', { toolStatus: 'running', toolImages: [image('a')], toolLeftOut: ['x'] })
    expect(hasToolStrip(toolStrip([running]))).toBe(false)
  })

  test('an open tool line plays each clip with its number and format, and lists what the host left out, on every client', () => {
    // WHY: the open line is where the person plays the audio and reads why
    // part of the result is missing. Desktop and mobile read one rule, so a
    // label or a running call reads the same on each.
    const speech = call('t1', {
      toolAudio: [{ assetId: asset('b', 'mp3'), mimeType: 'audio/mpeg' }, { assetId: asset('c', 'wav'), mimeType: 'audio/wav' }],
      toolLeftOut: ['Panel "errors": past the 5 MB limit'],
    })
    expect(openLineAudio(speech).map((clip) => clip.label)).toEqual(['Audio 1 · MP3', 'Audio 2 · WAV'])
    expect(openLineLeftOut(speech)).toEqual(['Panel "errors": past the 5 MB limit'])
    const mobileTool: ToolItem = {
      kind: 'tool', id: 't1', toolId: 't1', toolName: 'mcp__solus__elevenlabs__text_to_speech', input: null, status: 'completed',
      errorHead: null, childCount: 0, subagent: null, report: null, audio: speech.toolAudio, leftOut: speech.toolLeftOut,
    }
    expect(openLineAudio(toolCallOutputs(mobileTool))).toEqual(openLineAudio(speech))
    expect(openLineLeftOut(toolCallOutputs(mobileTool))).toEqual(openLineLeftOut(speech))
    // A call still running has no clip and no note yet.
    const running = call('t2', { ...speech, toolStatus: 'running' })
    expect(openLineAudio(running)).toEqual([])
    expect(openLineLeftOut(running)).toEqual([])
  })

  test('a browser capture shows once, as its capture card outside the folds', () => {
    // WHY: browser_snapshot also returns a scaled copy of the page to the agent.
    // The capture card already shows the page, so the copy would show it twice.
    expect(toolStrip([call('t1', { toolName: 'mcp__solus__browser_snapshot', toolImages: [image('a')] })]).thumbnails).toEqual([])
    expect(toolStrip([call('t2', { toolName: 'device_screenshot', toolImages: [image('a')] })]).thumbnails).toHaveLength(1)
  })

  test('many images: the strip shows the limit in call order, and the +N tile opens the rest', () => {
    const tools = [0, 1, 2].map((index) => call(`t${index}`, {
      toolImages: Array.from({ length: 4 }, (_, n) => image(String.fromCharCode(97 + index * 4 + n))),
    }))
    // The same picture from a later call is shown once.
    tools.push(call('t3', { toolImages: [image('a')] }))
    const strip = toolStrip(tools)
    expect(strip.thumbnails).toHaveLength(TOOL_STRIP_IMAGE_LIMIT)
    expect(strip.thumbnails.map((entry) => entry.toolId)).toEqual(['t0', 't0', 't0', 't0', 't1', 't1'])
    expect(strip.images).toHaveLength(12)
    expect(strip.moreCount).toBe(6)
    // The tile opens the viewer on the first image past the limit.
    expect(strip.images[strip.thumbnails.length].label).toBe('grafana image 7')
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
    expect(integrationAgentToolLabel('mcp__solus__add_mcp_server', '{"name":"opensearch"}')).toBe('Add opensearch for every agent')
    expect(integrationAgentToolLabel('mcp__linear__create_issue')).toBeNull()
  })

  test('the strip names the server of a call', () => {
    expect(toolServerName('mcp__solus__grafana__render_panels')).toBe('grafana')
    expect(toolServerName('read_integration_resource', '{"server":"linear","uri":"x"}')).toBe('linear')
    expect(toolServerName('Bash')).toBeNull()
  })
})
