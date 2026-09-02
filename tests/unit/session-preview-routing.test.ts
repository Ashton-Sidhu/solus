import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const controlPlane = readFileSync(
  join(process.cwd(), 'packages/server/src/control-plane.ts'),
  'utf8',
)

describe('session preview routing', () => {
  test('translates a stable one-member session to its provider transcript', () => {
    // WHY: task links use the stable Solus id, while the provider stores the
    // transcript under its own thread id. Passing the stable id to the backend
    // returns an empty preview for a session that has messages.
    expect(controlPlane).toContain('const previewAgentId = member?.provider ?? agentId')
    expect(controlPlane).toContain('const previewSessionId = member?.providerSessionId ?? sessionId')
    expect(controlPlane).toContain(
      'return backend.loadSessionPreview(previewSessionId, previewProjectPath)',
    )
  })
})
