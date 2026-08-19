import { describe, expect, test } from 'bun:test'
import { buildGoogleDiagramAssets } from '@solus/workspace-ui/components/document-shell/lib/google-diagrams'
import { serializeDiagramEmbed } from '@solus/contracts/diagram-embed'
import type { Work } from '@solus/contracts/types'

const diagram: Work = {
  id: 'diagram-1',
  title: 'System Architecture',
  type: 'diagram',
  content: '{"nodes":[{"id":"api","label":"API"}],"edges":[]}',
  preview: '1 node · 0 connections',
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  agentProvider: 'codex',
  cwd: '/project',
}

describe('Google diagram asset preparation', () => {
  test('deduplicates repeated diagram references', async () => {
    const token = serializeDiagramEmbed({ workId: diagram.id, title: diagram.title })
    let loads = 0
    let encodes = 0
    const assets = await buildGoogleDiagramAssets(
      `${token}\n\n${token}`,
      async () => {
        loads += 1
        return diagram
      },
      async (svg) => {
        encodes += 1
        expect(svg).toContain('API')
        return 'png-base64'
      },
    )

    expect(loads).toBe(1)
    expect(encodes).toBe(1)
    expect(assets).toEqual([{ workId: diagram.id, title: diagram.title, mimeType: 'image/png', base64: 'png-base64' }])
  })

  test('fails before upload when the source work is unavailable', () => {
    const token = serializeDiagramEmbed({ workId: 'missing', title: 'Missing diagram' })
    expect(buildGoogleDiagramAssets(token, async () => null, async () => '')).rejects.toThrow('is unavailable')
  })
})
