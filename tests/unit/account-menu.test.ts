import { describe, expect, test } from 'bun:test'
import { accountInitial, consolePageUrl } from '@solus/workspace-ui/components/session/lib/account-menu'

// The sidebar account menu: an avatar with no picture still names the person,
// and its links land on the account website this session signed in to — a
// staging or development origin included, never a hard-coded production one.

describe('the sidebar account menu', () => {
  test('an avatar without a picture shows the name, else the email', () => {
    expect(accountInitial({ id: 'a', email: 'ada@example.test', name: 'ada Lovelace', avatarUrl: null })).toBe('A')
    expect(accountInitial({ id: 'a', email: 'grace@example.test', name: null, avatarUrl: null })).toBe('G')
    expect(accountInitial({ id: 'a', email: 'grace@example.test', name: '  ', avatarUrl: null })).toBe('G')
  })

  test('account and organization links follow the session origin', () => {
    expect(consolePageUrl('https://app.solus.sh', 'account')).toBe('https://app.solus.sh/account')
    expect(consolePageUrl('http://localhost:5173/', 'teams')).toBe('http://localhost:5173/teams')
  })
})
