import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import type { AttachmentUploadRequest, AttachmentUploadTokenRequest } from '@solus/contracts/rpc'
import type { IpcContext, PromptOptions } from '@solus/contracts/types'
import { ConversationController } from '../../apps/mobile/solus-core/features/conversation/conversation-controller'
import { DEFAULT_RUN_SETTINGS } from '../../apps/mobile/solus-core/features/conversation/lib/ipc-context'
import { attachmentSizeProblem, attachmentTransferProgress, composePrompt, uploadAttachment, type AttachmentIo, type PickedFile, type UploadedAttachment } from '../../apps/mobile/solus-core/features/conversation/lib/attachments'
import { memoryKeyValueStore } from '../../apps/mobile/solus-core/platform/ports'
import { createHostWorld, FakeApi, healthFetch } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

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
  test('size limits match the host: 10 MB a file, 50 MB a video', () => {
    expect(attachmentSizeProblem([{ ...doc, size: 11 * MB }])).toContain('spec.pdf')
    expect(attachmentSizeProblem([clip])).toBeNull()
    expect(attachmentSizeProblem([{ ...clip, size: 51 * MB }])).toContain('50 MB')
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
    expect(uploaded).toEqual({ id: 'a1', kind: 'image', localUri: photo.uri, name: 'photo.jpg', hostPath: '/data/attachments/s/1-photo.jpg', mimeType: 'image/jpeg', size: 1000, dataUrl: 'data:image/jpeg;base64,QUJDREVG' })
  })

  test('a DNG goes up as a file with the DNG type, even when the picker calls it a JPEG', async () => {
    // WHY: an image attachment is sent to the agent as image content, and Claude refuses a DNG.
    const calls: AttachmentUploadRequest[] = []
    const { io } = fakeIo()
    const api = {
      attachUpload: async (_ctx: IpcContext, request: AttachmentUploadRequest) => { calls.push(request); return '/data/attachments/s/1-photo.dng' },
      attachUploadToken: async () => { throw new Error('unused') },
    }
    const raw: PickedFile = { uri: 'file:///p/photo.DNG', name: 'photo.DNG', mimeType: 'image/jpeg', size: 1000 }
    const uploaded = await uploadAttachment(raw, { api, ctx: {} as IpcContext, serverUrl: 'http://h:1', io, uuid: () => 'd1' })
    expect(calls).toEqual([{ name: 'photo.DNG', mime: 'image/x-adobe-dng', dataUrl: 'data:image/x-adobe-dng;base64,QUJDREVG' }])
    expect(uploaded).toMatchObject({ kind: 'file', mimeType: 'image/x-adobe-dng', dataUrl: null })
  })

  test('a host that accepts stored image refs receives a photo without a base64 read', async () => {
    const { io, uploads } = fakeIo()
    io.readBase64 = async () => { throw new Error('the phone must not encode a streamed photo') }
    const api = {
      attachUpload: async () => { throw new Error('the photo must go over HTTP') },
      attachUploadToken: async (_ctx: IpcContext, request: AttachmentUploadTokenRequest) => {
        expect(request).toEqual({ name: photo.name, mime: photo.mimeType!, size: photo.size! })
        return { relativeUrl: '/api/uploads/photo', hostPath: '/h/photo.jpg', expiresAt: 0 }
      },
    }
    const uploaded = await uploadAttachment(photo, {
      api, io, ctx: {} as IpcContext, serverUrl: 'https://host.tunnel', uuid: () => 'a1',
      streamImages: true,
    })
    expect(uploads).toEqual([{ url: 'https://host.tunnel/api/uploads/photo', uri: photo.uri }])
    expect(uploaded).toMatchObject({ kind: 'image', dataUrl: null, localUri: photo.uri })
    expect(composePrompt('Look', [uploaded], true).imageAttachmentRefs).toEqual([
      { name: photo.name, mimeType: photo.mimeType!, hostPath: '/h/photo.jpg' },
    ])
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
    // The picked file stays on the phone for the composer thumbnail only; the prompt names the host path.
    expect(uploaded).toMatchObject({ kind: 'file', hostPath: '/data/attachments/s/2-clip.mov', dataUrl: null, localUri: 'file:///p/clip.mov' })

    const refused = fakeIo(409)
    await expect(uploadAttachment(clip, { api, ctx: {} as IpcContext, serverUrl: 'http://h:1', io: refused.io, uuid: () => 'v2' })).rejects.toThrow('409')
  })

  test('native transfer progress reaches the draft and removing the file aborts the transfer', async () => {
    const abort = new AbortController()
    let finishStart!: () => void
    const started = new Promise<void>(resolve => { finishStart = resolve })
    let interrupted = false
    const uploading = uploadAttachment(clip, {
      api: {
        attachUpload: async () => { throw new Error('unused') },
        attachUploadToken: async () => ({ relativeUrl: '/api/uploads/clip', hostPath: '/h/clip.mov', expiresAt: 0 }),
      },
      ctx: {} as IpcContext,
      serverUrl: 'https://host.tunnel',
      hostId: 'test-host',
      uuid: () => 'progress-clip',
      signal: abort.signal,
      io: {
        readBase64: async () => { throw new Error('unused') },
        uploadFile: async (_url, _uri, transfer) => new Promise<number>(resolve => {
          transfer!.signal.addEventListener('abort', () => { interrupted = true; resolve(499) }, { once: true })
          transfer!.reportProgress(0.57)
          finishStart()
        }),
      },
    })
    await started
    expect(attachmentTransferProgress('test-host', 'progress-clip')).toBe(0.55)
    expect(attachmentTransferProgress('another-host', 'progress-clip')).toBeUndefined()
    abort.abort()
    await expect(uploading).rejects.toThrow()
    expect(interrupted).toBe(true)
  })

  test('a signed upload stops before sending bytes when its account scope changes', async () => {
    let hasAccess = true
    const { io, uploads } = fakeIo()
    const uploading = uploadAttachment(clip, {
      api: {
        attachUpload: async () => { throw new Error('unused') },
        attachUploadToken: async () => {
          hasAccess = false
          return { relativeUrl: '/api/uploads/clip', hostPath: '/h/clip.mov', expiresAt: 0 }
        },
      },
      ctx: {} as IpcContext,
      serverUrl: 'https://host.tunnel',
      uuid: () => 'scope-clip',
      io,
      checkAccess: () => { if (!hasAccess) throw new Error('Account changed.') },
    })
    await expect(uploading).rejects.toThrow('Account changed.')
    expect(uploads).toHaveLength(0)
  })

  test('verifies a staged file after a lost upload response and keeps it on send', async () => {
    const operations: string[] = []
    const attached = await uploadAttachment(clip, {
      api: {
        attachUpload: async () => { throw new Error('unused') },
        attachUploadToken: async (_ctx, request) => {
          expect(request.pending).toBe(true)
          return { relativeUrl: '/api/uploads/clip', pendingUrl: '/api/uploads/clip/pending',
            hostPath: '/h/clip.mov', expiresAt: 0 }
        },
      },
      ctx: {} as IpcContext,
      serverUrl: 'https://host.tunnel',
      uuid: () => 'staged-clip',
      stage: true,
      io: {
        readBase64: async () => { throw new Error('unused') },
        uploadFile: async () => { throw new Error('Response lost') },
        manageUpload: async (_url, method) => { operations.push(method); return 204 },
      },
    })
    expect(operations).toEqual(['HEAD'])
    expect(await attached.pending?.keep()).toMatchObject({ hostPath: '/h/clip.mov' })
    expect(operations).toEqual(['HEAD', 'POST'])
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

  test('a host chip in the text gets the note for the agent, after the text and after the file lines', () => {
    // WHY: host-fleet.md D12. The agent must know what it can do with a host
    // the person names, on the phone as on desktop.
    const typed = 'Check [studio-mini](host://ref?serverId=install-1).'
    const { prompt } = composePrompt(typed, [{ id: '1', kind: 'file', name: 'spec.pdf', hostPath: '/h/spec.pdf', mimeType: 'application/pdf', size: 1, dataUrl: null }], true)
    expect(prompt.startsWith(`[Attached file: /h/spec.pdf]\n\n${typed}\n\n[Referenced Host: "studio-mini" (host: install-1)]`)).toBe(true)
  })
})

describe('native attachments in a conversation', () => {
  test('a draft uploads and sends more than eight screenshots in its first prompt', async () => {
    const uploadContexts: IpcContext[] = []
    const { io, uploads } = fakeIo()
    const inlineFiles: string[] = []
    const api = new FakeApi()
      .on('watchSession', () => ({}))
      .on('serverGetCapabilities', () => ({ promptImageRefs: true, attachStreamUpload: true }))
      .on('attachUpload', (ctx: IpcContext, request: AttachmentUploadRequest) => {
        inlineFiles.push(request.name)
        uploadContexts.push(ctx)
        return `/h/${request.name}`
      })
      .on('attachUploadToken', (ctx: IpcContext, request: AttachmentUploadTokenRequest) => {
        uploadContexts.push(ctx)
        return { relativeUrl: `/api/uploads/${request.name}`, hostPath: `/h/${request.name}`, expiresAt: 0 }
      })
      .on('prompt', () => ({ disposition: 'started' }))
    const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
    await world.registry.load()
    await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 't')
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
      attachmentIo: io,
      onChange: () => {},
    })
    await controller.load()
    const photos = Array.from({ length: 12 }, (_, index) => ({ ...photo, name: `photo-${index}.jpg` }))
    const files = [...photos, doc]
    await controller.attach(files)
    expect(uploads.map(({ url }) => url)).toEqual(photos.map(({ name }) => `http://a:1/api/uploads/${name}`))
    expect(inlineFiles).toEqual([doc.name])
    expect(uploadContexts.map((ctx) => [ctx.session.sessionId, ctx.session.draftId])).toEqual(files.map(() => ['', 'new-1']))
    expect(controller.attachments.map((attachment) => attachment.name)).toEqual(files.map((file) => file.name))

    await controller.send('What is wrong here?')
    const [, options] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(options).toMatchObject({
      prompt: '[Attached file: /h/spec.pdf]\n\nWhat is wrong here?',
      displayPrompt: 'What is wrong here?',
      imageAttachmentRefs: photos.map(({ mimeType, name }) => ({ mimeType, name, hostPath: `/h/${name}` })),
    })
    expect(options.imageAttachmentRefs).toHaveLength(photos.length)
    expect(controller.attachments).toEqual([])

    // Once the host has the session, uploads name it.
    await controller.attach([doc])
    expect(uploadContexts.at(-1)?.session).toMatchObject({ sessionId: 'new-1' })
    expect(uploadContexts.at(-1)?.session.draftId).toBeUndefined()
  })
})

// Send works while a file uploads (T3 Code #33092): the message shows at once
// and goes to the host when its files land. A failed upload sends nothing and
// gives the text and the landed files back to the composer.
describe('native send while an attachment uploads', () => {
  async function uploadingConversation() {
    const uploads: Array<{ resolve: (path: string) => void; reject: (error: Error) => void }> = []
    const api = new FakeApi()
      .on('watchSession', () => ({}))
      .on('serverGetCapabilities', () => ({ promptImageRefs: true }))
      .on('attachUpload', (_ctx: IpcContext, request: AttachmentUploadRequest) =>
        new Promise<string>((resolve, reject) => { uploads.push({ resolve: () => resolve(`/h/${request.name}`), reject }) }))
      .on('prompt', () => ({ disposition: 'started' }))
    const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
    await world.registry.load()
    await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 't')
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
    return { api, controller, uploads, storage }
  }
  const userTexts = (controller: ConversationController) =>
    [...controller.model.items.values()].flatMap((item) => (item.kind === 'user' ? [item.text] : []))
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

  test('starts up to three uploads together and keeps the selection order when they land', async () => {
    const { controller, uploads } = await uploadingConversation()
    const files = ['first', 'second', 'third', 'fourth'].map(name => ({ ...photo, name: `${name}.jpg` }))
    const attaching = controller.attach(files)
    await settle()
    expect(uploads).toHaveLength(3)
    uploads[1]!.resolve('/h/second.jpg')
    await settle()
    expect(uploads).toHaveLength(4)
    expect(controller.attachments).toEqual([])
    uploads[3]!.resolve('/h/fourth.jpg')
    uploads[2]!.resolve('/h/third.jpg')
    uploads[0]!.resolve('/h/first.jpg')
    await attaching
    expect(controller.attachments.map(file => file.name)).toEqual(files.map(file => file.name))
  })

  test('a failed photo stays in the composer and retry keeps its identity', async () => {
    const { controller, uploads } = await uploadingConversation()
    const attaching = controller.attach([photo])
    const id = controller.pendingImages[0]!.id
    await settle()
    uploads[0]!.reject(new Error('Upload interrupted'))
    await attaching
    expect(controller.failedAttachments).toMatchObject([{ id, file: photo, reason: 'Upload interrupted' }])
    const retrying = controller.retryAttachment(id)
    expect(controller.pendingImages[0]?.id).toBe(id)
    await settle()
    uploads[1]!.resolve('/h/photo.jpg')
    await retrying
    expect(controller.failedAttachments).toEqual([])
    expect(controller.attachments[0]).toMatchObject({ id, hostPath: '/h/photo.jpg' })
  })

  test('a new draft can close once its local save succeeds, before host delivery', async () => {
    const { api, controller, uploads, storage } = await uploadingConversation()
    const attaching = controller.attach([photo])
    const savedIds: string[] = []
    const sending = controller.send('Describe the photo', {
      onQueued: id => {
        expect(storage.keys().some(key => storage.getItem(key)?.includes(id))).toBe(true)
        expect(api.callsOf('prompt')).toHaveLength(0)
        savedIds.push(id)
      },
    })
    await settle()
    expect(savedIds).toHaveLength(0)
    uploads[0]!.resolve('/h/photo.jpg')
    await Promise.all([sending, attaching])
    expect(savedIds).toHaveLength(1)
    expect(api.callsOf('prompt')).toHaveLength(1)
  })

  test('a failed local save keeps the attachment for retry and leaves the draft open', async () => {
    const { api, controller, storage, uploads } = await uploadingConversation()
    const attaching = controller.attach([photo])
    await settle()
    uploads[0]!.resolve('/h/photo.jpg')
    await attaching
    storage.setItem = () => { throw new Error('disk full') }
    let queued = false
    await expect(controller.send('Describe the photo', { onQueued: () => { queued = true } }))
      .rejects.toThrow('local outbox')
    expect(queued).toBe(false)
    expect(api.callsOf('prompt')).toHaveLength(0)
    expect(userTexts(controller)).toEqual([])
    expect(controller.attachments.map(file => file.name)).toEqual(['photo.jpg'])
  })

  test('the message shows at once; the prompt goes, naming the file, when the upload lands', async () => {
    const { api, controller, uploads } = await uploadingConversation()
    const attaching = controller.attach([doc])
    await settle()
    expect(controller.uploading).toBe(1)

    let submittedId = ''
    const sending = controller.send('What is wrong here?', { onSubmitted: id => { submittedId = id } })
    expect(controller.model.items.get(submittedId)?.kind).toBe('user')
    await settle()
    expect(userTexts(controller)).toEqual(['What is wrong here?'])
    // The upload belongs to the sent message now, not to the composer.
    expect(controller.uploading).toBe(0)
    expect(api.callsOf('prompt')).toHaveLength(0)

    uploads[0]!.resolve('/h/spec.pdf')
    await Promise.all([attaching, sending])
    const [, options] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(options.prompt).toBe('[Attached file: /h/spec.pdf]\n\nWhat is wrong here?')
    // The landed file went with the message; it does not stay for the next one.
    expect(controller.attachments).toEqual([])
  })

  test('a photo stays visible when sent during upload and the host receives its stored reference', async () => {
    const { api, controller, uploads } = await uploadingConversation()
    const attaching = controller.attach([photo])
    expect(controller.pendingImages[0]?.previewUri).toBe(photo.uri)
    await settle()
    const sending = controller.send('')
    await settle()
    const user = [...controller.model.items.values()].find(item => item.kind === 'user')
    expect(user?.attachments[0]).toMatchObject({ kind: 'local-image', uri: photo.uri })
    expect(controller.pendingImages).toEqual([])
    uploads[0]!.resolve('/h/photo.jpg')
    await Promise.all([attaching, sending])
    const [, options] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(options.imageAttachmentRefs?.[0]?.hostPath).toBe('/h/photo.jpg')
  })

  test('a removed thumbnail stays removed when the host finishes its upload', async () => {
    const { controller, uploads } = await uploadingConversation()
    const attaching = controller.attach([photo])
    await settle()
    controller.removeAttachment(controller.pendingImages[0]!.id)
    expect(controller.pendingImages).toEqual([])
    uploads[0]!.resolve('/h/photo.jpg')
    await attaching
    expect(controller.attachments).toEqual([])
  })

  test('a failed upload sends nothing and gives back the text and the files that landed', async () => {
    const { api, controller, uploads } = await uploadingConversation()
    const attaching = controller.attach([photo, doc])
    await settle()
    uploads[0]!.resolve('/h/photo.jpg')
    await settle()
    let restoreDraft = false
    const sending = controller.send('Review these', { onUploadFailed: () => { restoreDraft = true } })
    await settle()
    uploads[1]!.reject(new Error('offline'))
    await Promise.all([attaching, sending])

    expect(api.callsOf('prompt')).toHaveLength(0)
    expect(userTexts(controller)).toEqual([])
    expect(controller.attachments.map((attachment) => attachment.name)).toEqual(['photo.jpg'])
    const notices = [...controller.model.items.values()].flatMap((item) => (item.kind === 'notice' ? [item.text] : []))
    expect(notices.some((text) => text.includes('not sent'))).toBe(true)
    expect(restoreDraft).toBe(true)
  })
})
