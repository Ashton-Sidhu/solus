import { describe, expect, test } from 'bun:test'
import { buildDiagramAssets } from '@solus/workspace-ui/components/document-shell/lib/diagram-assets'
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

describe('Document diagram asset preparation', () => {
  test('renders each distinct diagram once, from the work itself', async () => {
    // WHY: every render mounts a canvas, so a plan that embeds the same
    // diagram twice must pay for it once and get one asset both embeds share.
    const token = serializeDiagramEmbed({ workId: diagram.id, title: diagram.title })
    let loads = 0
    const rendered: Work[] = []
    const assets = await buildDiagramAssets(
      `${token}\n\n${token}`,
      async () => {
        loads += 1
        return diagram
      },
      async (work) => {
        rendered.push(work)
        return 'png-base64'
      },
    )

    expect(loads).toBe(1)
    expect(rendered).toEqual([diagram])
    expect(assets).toEqual([{ workId: diagram.id, title: diagram.title, mimeType: 'image/png', base64: 'png-base64' }])
  })

  test('fails before upload when the source work is unavailable', () => {
    const token = serializeDiagramEmbed({ workId: 'missing', title: 'Missing diagram' })
    expect(buildDiagramAssets(token, async () => null, async () => 'png-base64')).rejects.toThrow('is unavailable')
  })

  test('fails before upload when a diagram has nothing to draw', () => {
    // WHY: the publish needs an image for every embed it meets, so an empty
    // diagram is reported here, by name, instead of as an upload error.
    const token = serializeDiagramEmbed({ workId: diagram.id, title: diagram.title })
    expect(buildDiagramAssets(token, async () => diagram, async () => null)).rejects.toThrow('is empty')
  })
})
