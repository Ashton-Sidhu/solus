import { describe, expect, test } from 'bun:test'
import { composeAttachmentContext } from '../../src/renderer/contexts/workspace/prompt-composer'

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
})
