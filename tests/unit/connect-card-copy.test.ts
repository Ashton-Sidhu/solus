import { describe, expect, test } from 'bun:test'
import { connectCardCopy, integrationConnectCardCopy } from '@solus/workspace-ui/components/connections/lib/connect-card-copy'

/**
 * The connect card's type word says what the account is for, in the user's
 * terms. Someone who asked to "set up Jira" must see Jira, not only the account
 * name that serves it.
 */
describe('connect card copy', () => {
  test('a Jira request names Jira in the title and the reason', () => {
    const copy = connectCardCopy('atlassian', 'jira')
    expect(copy.title).toBe('Connect Jira')
    expect(copy.reason).toBe('for Jira issues')
    expect(copy.providerLabel).toBe('Atlassian')
  })

  test('the reason is a lowercase phrase, never a kicker', () => {
    expect(connectCardCopy('google', 'drive').reason).toBe('for Google Docs')
    expect(connectCardCopy('github', 'pull-requests').reason).toBe('for pull requests')
  })

  test('an integration card says what it is for once, in the type word', () => {
    const copy = integrationConnectCardCopy('GitHub')
    expect(copy.title).toBe('Connect GitHub')
    expect(copy.reason).toBe('to use its tools')
    expect(copy.purpose).toBeUndefined()
  })
})
