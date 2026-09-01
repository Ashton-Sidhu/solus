import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('standalone server OAuth packaging', () => {
  test('embeds every build-time OAuth application credential', () => {
    const packageServerSource = readFileSync(resolve(import.meta.dir, '../../scripts/package-server.ts'), 'utf8')

    for (const environmentVariable of [
      'SOLUS_GOOGLE_CLIENT_ID',
      'SOLUS_GOOGLE_CLIENT_SECRET',
      'SOLUS_GITHUB_CLIENT_ID',
    ]) {
      expect(packageServerSource).toContain(`--define:process.env.${environmentVariable}=`)
    }
  })
})
