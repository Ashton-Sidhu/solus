import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import type { AttachmentUploadRequest, AttachmentUploadTokenRequest } from '@solus/contracts/rpc'
import type { IpcContext, PromptOptions, WatchSessionInput } from '@solus/contracts/types'
import { ConversationController } from '../../apps/mobile/src/features/conversation/conversation-controller'
import { DEFAULT_RUN_SETTINGS } from '../../apps/mobile/src/features/conversation/lib/ipc-context'
import { attachmentLimitProblem, composePrompt, uploadAttachment, type AttachmentIo, type PickedFile, type UploadedAttachment } from '../../apps/mobile/src/features/conversation/lib/attachments'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, healthFetch } from './helpers/native-mobile-fakes'

const MB = 1024 * 1024
const photo: PickedFile = { uri: 'file:///p/photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg', size: 1000 }
const doc: PickedFile = { uri: 'file:///p/spec.pdf', name: 'spec.pdf', mimeType: 'application/pdf', size: 2000 }
const clip: PickedFile = { uri: 'file:///p/clip.mov', name: 'clip.mov', mimeType: 'video/quicktime', size: 30 * MB }

function fakeIo(status = 204) {
  const uploads: Array<{ url: string; uri: string }> = []
  const io: AttachmentIo = {
    readBase64: async () => 'QUJD\nREVG',
    uploadFile: async (url, uri) => { uploads.push({ url, uri }); return status },
  }
  return { io, uploads }
}

describe('native attachments', () => {
  test('limits match the host: eight per message, 10 MB a file, 50 MB a video', () => {
    expect(attachmentLimitProblem([photo], 8)).toContain('up to 8')
    expect(attachmentLimitProblem([{ ...doc, size: 11 * MB }], 0)).toContain('spec.pdf')
    expect(attachmentLimitProblem([clip], 0)).toBeNull()
    expect(attachmentLimitProblem([{ ...clip, size: 51 * MB }], 0)).toContain('50 MB')
  })

  test('a photo goes over the upload RPC as base64 without line breaks', async () => {
    const calls: AttachmentUploadRequest[] = []
    const { io } = fakeIo()
    const api = {
      attachUpload: async (_ctx: IpcContext, request: AttachmentUploadRequest) => { calls.push(request); return '/data/attachments/s/1-photo.jpg' },
      attachUploadToken: async () => { throw new Error('unused') },
    }
    const uploaded = await uploadAttachment(photo, { api, ctx: {} as IpcContext, serverUrl: 'http://h:1', io, uuid: () => 'a1' })
    expect(calls).toEqual([{ name: 'photo.jpg', mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,QUJDREVG' }])
    expect(uploaded).toEqual({ id: 'a1', kind: 'image', name: 'photo.jpg', hostPath: '/data/attachments/s/1-photo.jpg', mimeType: 'image/jpeg', size: 1000, dataUrl: 'data:image/jpeg;base64,QUJDREVG' })
  })

  test('a video streams its bytes to the signed route; a refused upload is an error', async () => {
    const tokens: AttachmentUploadTokenRequest[] = []
    const api = {
      attachUpload: async () => { throw new Error('a video must not go over the RPC') },
      attachUploadToken: async (_ctx: IpcContext, request: AttachmentUploadTokenRequest) => {
        tokens.push(request)
        return { relativeUrl: '/api/uploads/tok', hostPath: '/data/attachments/s/2-clip.mov', expiresAt: 0 }
      },
    }
    const ok = fakeIo(204)
    const uploaded = await uploadAttachment(clip, { api, ctx: {} as IpcContext, serverUrl: 'https://host.tunnel/', io: ok.io, uuid: () => 'v1' })
    expect(tokens).toEqual([{ name: 'clip.mov', mime: 'video/quicktime', size: 30 * MB }])
    expect(ok.uploads).toEqual([{ url: 'https://host.tunnel/api/uploads/tok', uri: 'file:///p/clip.mov' }])
    expect(uploaded).toMatchObject({ kind: 'file', hostPath: '/data/attachments/s/2-clip.mov', dataUrl: null })

    const refused = fakeIo(409)
    await expect(uploadAttachment(clip, { api, ctx: {} as IpcContext, serverUrl: 'http://h:1', io: refused.io, uuid: () => 'v2' })).rejects.toThrow('409')
  })

  test('the prompt names files by host path; images ride as refs or inline', () => {
    const attachments: UploadedAttachment[] = [
      { id: '1', kind: 'file', name: 'spec.pdf', hostPath: '/h/spec.pdf', mimeType: 'application/pdf', size: 1, dataUrl: null },
      { id: '2', kind: 'image', name: 'photo.jpg', hostPath: '/h/photo.jpg', mimeType: 'image/jpeg', size: 1, dataUrl: 'data:image/jpeg;base64,AA' },
    ]
    expect(composePrompt('Review this', attachments, true)).toEqual({
      prompt: '[Attached file: /h/spec.pdf]\n\nReview this',
      imageAttachmentRefs: [{ mimeType: 'image/jpeg', hostPath: '/h/photo.jpg', name: 'photo.jpg' }],
    })
    expect(composePrompt('Look', attachments.slice(1), false)).toEqual({ prompt: 'Look', imageAttachments: [{ mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AA' }] })
  })
})

describe('native attachments in a conversation', () => {
  test('before the first prompt an upload names a draft; the prompt then carries the files', async () => {
    const uploadContexts: IpcContext[] = []
    const api = new FakeApi()
      .on('watchSession', (input: WatchSessionInput) => ({ sessionId: input.sessionId! }))
      .on('serverGetCapabilities', () => ({ promptImageRefs: true }))
      .on('attachUpload', (ctx: IpcContext, request: AttachmentUploadRequest) => { uploadContexts.push(ctx); return `/h/${request.name}` })
      .on('prompt', () => ({ disposition: 'started' }))
    const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
    await world.registry.load()
    await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 't')
    const connection = world.connections.connection('inst-a')!
    await world.transports[0]!.accept()
    const storage = memoryKeyValueStore()
    let next = 0
    const controller = new ConversationController({ hostId: 'inst-a', newSession: { sessionId: 'new-1', provider: 'claude-code', workingDirectory: '/w' } }, {
      executionPreferences: () => ({}),
      connection,
      outbox: new SendOutbox(() => storage),
      runSettings: async () => DEFAULT_RUN_SETTINGS,
      organizationId: () => null,
      uuid: () => `id-${++next}`,
      attachmentIo: fakeIo().io,
      onChange: () => {},
    })
    await controller.load()
    await controller.attach([photo, doc])
    expect(uploadContexts.map((ctx) => [ctx.session.sessionId, ctx.session.draftId])).toEqual([['', 'new-1'], ['', 'new-1']])
    expect(controller.attachments.map((attachment) => attachment.name)).toEqual(['photo.jpg', 'spec.pdf'])

    await controller.send('What is wrong here?')
    const [, options] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(options).toMatchObject({
      prompt: '[Attached file: /h/spec.pdf]\n\nWhat is wrong here?',
      displayPrompt: 'What is wrong here?',
      imageAttachmentRefs: [{ mimeType: 'image/jpeg', hostPath: '/h/photo.jpg', name: 'photo.jpg' }],
    })
    expect(controller.attachments).toEqual([])

    // Once the host has the session, uploads name it.
    await controller.attach([doc])
    expect(uploadContexts.at(-1)?.session).toMatchObject({ sessionId: 'new-1' })
    expect(uploadContexts.at(-1)?.session.draftId).toBeUndefined()
  })
})
