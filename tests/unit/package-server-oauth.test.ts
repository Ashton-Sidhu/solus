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
      'SOLUS_ATLASSIAN_CLIENT_ID',
      'SOLUS_ATLASSIAN_CLIENT_SECRET',
    ]) {
      expect(packageServerSource).toContain(`--define:process.env.${environmentVariable}=`)
    }
  })

  test('release workflows provide every build-time OAuth application credential', () => {
    const desktopWorkflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/release.yml'), 'utf8')
    const serverWorkflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/release-server.yml'), 'utf8')

    for (const environmentVariable of [
      'SOLUS_GOOGLE_CLIENT_ID',
      'SOLUS_GOOGLE_CLIENT_SECRET',
      'SOLUS_GITHUB_CLIENT_ID',
      'SOLUS_ATLASSIAN_CLIENT_ID',
      'SOLUS_ATLASSIAN_CLIENT_SECRET',
    ]) {
      expect(desktopWorkflow).toContain(`${environmentVariable}: \${{ secrets.${environmentVariable} }}`)
      expect(serverWorkflow).toContain(`${environmentVariable}: \${{ secrets.${environmentVariable} }}`)
    }
  })
})
