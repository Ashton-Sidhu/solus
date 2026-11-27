import { describe, expect, test } from 'bun:test'
import { missingSecretNames, secretVaultSummary } from '@solus/workspace-ui/components/app/manage/lib/app-secrets'

describe('the Secrets section', () => {
  const secrets = [
    { name: 'SLACK_WEBHOOK_URL', isSet: false },
    { name: 'GITHUB_TOKEN', isSet: true },
    { name: 'LINEAR_API_KEY', isSet: true },
    { name: 'POSTMARK_TOKEN', isSet: true },
  ]

  test('the head line counts the secrets with a value and names the host that keeps them', () => {
    expect(secretVaultSummary(secrets, 'studio-mini')).toBe('3 of 4 have a value · in the secret store on studio-mini')
    expect(secretVaultSummary([{ isSet: false }], 'studio-mini')).toBe('0 of 1 has a value · in the secret store on studio-mini')
  })

  test('the warning names each secret without a value, and is absent when all have one', () => {
    // WHY: the code reads every declared secret, so each empty one makes calls fail; a full set needs no warning.
    expect(missingSecretNames(secrets)).toEqual(['SLACK_WEBHOOK_URL'])
    expect(missingSecretNames(secrets.map((secret) => ({ ...secret, isSet: true })))).toEqual([])
  })
})
