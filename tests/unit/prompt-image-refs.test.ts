import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolvePromptImages } from '@solus/server/agents/prompt-image-refs'

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

async function attachmentStore(): Promise<{ root: string; stored: string }> {
  const root = await mkdtemp(join(tmpdir(), 'solus-attachments-'))
  const sessionDir = join(root, 'session-abc')
  await mkdir(sessionDir, { recursive: true })
  const stored = join(sessionDir, '0-deadbeef-shot.png')
  await writeFile(stored, PNG)
  return { root, stored }
}

describe('prompt image refs', () => {
  test('reads the host\'s own copy so a turn never carries the bytes', async () => {
    const { root, stored } = await attachmentStore()

    const images = await resolvePromptImages(
      { imageAttachmentRefs: [{ mimeType: 'image/png', hostPath: stored, name: 'shot.png' }] },
      root,
    )

    expect(images).toEqual([
      { mimeType: 'image/png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
    ])
  })

  test('refuses a path outside the attachment store', async () => {
    const { root } = await attachmentStore()
    const outside = join(tmpdir(), 'solus-not-an-attachment.png')
    await writeFile(outside, PNG)

    await expect(
      resolvePromptImages({ imageAttachmentRefs: [{ mimeType: 'image/png', hostPath: outside }] }, root),
    ).rejects.toThrow(/attachment store/)
  })

  test('fails the turn rather than dropping an image the host lost', async () => {
    const { root } = await attachmentStore()

    await expect(
      resolvePromptImages(
        { imageAttachmentRefs: [{ mimeType: 'image/png', hostPath: join(root, 'session-abc', 'gone.png') }] },
        root,
      ),
    ).rejects.toThrow(/no longer available/)
  })

  test('an older client mixing inline images with refs keeps both', async () => {
    const { root, stored } = await attachmentStore()

    const images = await resolvePromptImages(
      {
        imageAttachments: [{ mimeType: 'image/gif', dataUrl: 'data:image/gif;base64,R0lGOD' }],
        imageAttachmentRefs: [{ mimeType: 'image/png', hostPath: stored }],
      },
      root,
    )

    expect(images).toHaveLength(2)
    expect(images?.[0].mimeType).toBe('image/gif')
    expect(images?.[1].mimeType).toBe('image/png')
  })

  test('a prompt with no refs is passed through untouched', async () => {
    const inline = [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }]
    expect(await resolvePromptImages({ imageAttachments: inline })).toBe(inline)
  })
})
