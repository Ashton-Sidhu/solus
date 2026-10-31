import { describe, expect, test } from 'bun:test'
import {
  connectCardCopy,
  connectCardHeading,
  connectContinuePrompt,
  integrationConnectCardCopy,
} from '@solus/workspace-ui/components/connections/lib/connect-card-copy'

/**
 * A row of the connect card names what the account is for, in the user's
 * terms. Someone who asked to "set up Jira" must see Jira, not only the account
 * name that serves it.
 */
describe('connect card copy', () => {
  test('a Jira request names Jira in the row and says why', () => {
    const copy = connectCardCopy('atlassian', 'jira')
    expect(copy.name).toBe('Jira')
    expect(copy.purpose).toBe('Needed to read and update Jira issues.')
    expect(copy.providerLabel).toBe('Atlassian')
  })

  test('an account with no product of its own is named by the account', () => {
    expect(connectCardCopy('github', 'pull-requests').name).toBe('GitHub')
  })

  test('an integration row is named by the integration', () => {
    const copy = integrationConnectCardCopy('Linear')
    expect(copy.name).toBe('Linear')
    expect(copy.purpose).toBe('Needed to use its tools.')
  })

  test('the eyebrow counts the sign-ins until every row is settled', () => {
    expect(connectCardHeading(1, 0)).toBe('Sign-in needed')
    expect(connectCardHeading(3, 1)).toBe('3 sign-ins needed')
    expect(connectCardHeading(3, 3)).toBe('All connected')
    expect(connectCardHeading(1, 1)).toBe('Connected')
  })

  test('Continue names every account that was connected, so the agent knows what to retry', () => {
    expect(connectContinuePrompt(['Linear'])).toBe('Linear connected — continue')
    expect(connectContinuePrompt(['Linear', 'Notion', 'GitHub'])).toBe('Linear, Notion, and GitHub connected — continue')
  })
})
