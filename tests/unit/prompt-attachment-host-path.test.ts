import { describe, expect, test } from 'bun:test'
import { composeAttachmentContext } from '@solus/workspace-ui/contexts/workspace/prompt-composer'

describe('remote prompt attachment paths', () => {
  test('uses the uploaded host path and never the client-local path', () => {
    const clientPath = '/Users/client/Downloads/spec.pdf'
    const hostPath = '/srv/solus/attachments/session/0-spec.pdf'
    const prompt = composeAttachmentContext([{
      id: 'attachment-1',
      type: 'file',
      name: 'spec.pdf',
      path: clientPath,
      hostPath,
      hostServerId: 'remote-host',
      mimeType: 'application/pdf',
    }], 'remote-host')

    expect(prompt).toContain(hostPath)
    expect(prompt).not.toContain(clientPath)
  })

  test('keeps browser annotation context structured in the draft attachment', () => {
    const prompt = composeAttachmentContext([{
      id: 'preview-annotation:host:page',
      type: 'design-selection',
      name: 'Browser annotation',
      path: 'asset://capture.png',
      hostPath: '/srv/solus/assets/capture.png',
      hostServerId: 'remote-host',
      designData: {
        screenshot: 'asset://capture.png',
        annotationContext: '1. <button> "Save" — src/Save.svelte:42',
      },
    }], 'remote-host')

    expect(prompt).toContain('[Browser annotation: Browser annotation]')
    expect(prompt).toContain('/srv/solus/assets/capture.png')
    expect(prompt).toContain('src/Save.svelte:42')
    expect(prompt).not.toContain('[Design Mode Selection:')
  })
})
