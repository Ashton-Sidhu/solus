import { describe, expect, test } from 'bun:test'
import type { Attachment, Prompt } from '@solus/contracts/types'
import { PromptComposer } from '@solus/workspace-ui/contexts/workspace/prompt-composer'

const RUN_HOST = 'run-host'

function promptWith(attachments: Attachment[]): Prompt {
  return { text: '', attachments, planRefs: [], workRefs: [], sessionRefs: [] } as Prompt
}

function image(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'attachment-1',
    type: 'image',
    name: 'shot.png',
    path: '/Users/client/shot.png',
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,AAAA',
    hostPath: '/srv/solus/attachments/session/0-shot.png',
    hostServerId: RUN_HOST,
    ...overrides,
  }
}

// The stores are only read for plan/work/task context, which no case here uses.
const composer = new PromptComposer(
  { get: () => undefined } as unknown as ConstructorParameters<typeof PromptComposer>[0],
  { get: () => undefined } as unknown as ConstructorParameters<typeof PromptComposer>[1],
  { tasks: [], taskForSession: () => undefined } as unknown as ConstructorParameters<typeof PromptComposer>[2],
)

describe('how a turn carries its images', () => {
  test('an image the run host already stores travels as a ref, not as bytes', () => {
    const payload = composer.composeImagePayload(promptWith([image()]), RUN_HOST, true)

    expect(payload.refs).toEqual([
      { mimeType: 'image/png', hostPath: '/srv/solus/attachments/session/0-shot.png', name: 'shot.png' },
    ])
    expect(payload.inline).toEqual([])
  })

  test('a host that cannot resolve refs still receives the bytes', () => {
    const payload = composer.composeImagePayload(promptWith([image()]), RUN_HOST, false)

    expect(payload.refs).toEqual([])
    expect(payload.inline).toEqual([{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }])
  })

  test('an image the host never received falls back to bytes', () => {
    const payload = composer.composeImagePayload(
      promptWith([image({ hostPath: undefined, hostServerId: undefined })]),
      RUN_HOST,
      true,
    )

    expect(payload.refs).toEqual([])
    expect(payload.inline).toHaveLength(1)
  })

  test('a path owned by a different host is never sent to this one', () => {
    const payload = composer.composeImagePayload(
      promptWith([image({ hostServerId: 'some-other-host' })]),
      RUN_HOST,
      true,
    )

    expect(payload.refs).toEqual([])
    expect(payload.inline).toHaveLength(1)
  })

  test('file attachments stay text references in both modes', () => {
    const file = image({ id: 'attachment-2', type: 'file', name: 'spec.pdf', dataUrl: undefined })
    const payload = composer.composeImagePayload(promptWith([file]), RUN_HOST, true)

    expect(payload.refs).toEqual([])
    expect(payload.inline).toEqual([])
  })
})
