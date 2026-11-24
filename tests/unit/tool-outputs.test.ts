import { describe, expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import {
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
  test('the folded row keeps audio and left-out chips', () => {
    const speech = call('t1', {
      toolName: 'mcp__solus__elevenlabs__text_to_speech',
      toolAudio: [{ assetId: asset('b', 'mp3'), mimeType: 'audio/mpeg' }],
      toolLeftOut: ['Panel "saturation": past the 5 MB limit', 'Panel "errors": past the 5 MB limit'],
    })
    const strip = toolStrip([speech])
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

  test('a running call gives no chip, so the stream does no work for it', () => {
    const running = call('t1', { toolStatus: 'running', toolLeftOut: ['x'] })
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

  test('image-only calls add no strip below a folded turn or tool group', () => {
    const images = { toolImages: [image('a')] }
    const tools = [
      call('chart', images),
      call('browser', { ...images, toolName: 'mcp__solus__browser_snapshot' }),
      call('device', { ...images, toolName: 'device_screenshot' }),
      call('preview', { ...images, toolName: 'mcp__solus__render_artifact' }),
    ]
    expect(hasToolStrip(toolStrip(tools))).toBe(false)
    for (const tool of tools) expect(hasToolStrip(toolStrip([tool]))).toBe(false)
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
