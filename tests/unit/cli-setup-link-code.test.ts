import { expect, test } from 'bun:test'
import { LINK_CODE_ENV } from '@solus/contracts/uplink'
import { takeSetupLinkCode } from '../../apps/cli/src/lib/onboarding'

// WHY: `join_cloud_machine` sends an organization link code over SSH (plans/035 §5).
// A code in the arguments shows in `ps` to every user of the machine and joins any
// machine to the organization for ten minutes, so setup must take it from the
// environment, and remove it there, so the server that setup starts never sees it.

test('setup takes the link code from SOLUS_LINK_CODE and removes it', () => {
  const env: NodeJS.ProcessEnv = { [LINK_CODE_ENV]: ' ticket@cloud.example \n', HOME: '/home/solus' }
  expect(takeSetupLinkCode(undefined, env)).toBe('ticket@cloud.example')
  expect(LINK_CODE_ENV in env).toBe(false)
  expect(env.HOME).toBe('/home/solus')
})

test('--link wins over the environment, and the variable is still removed', () => {
  const env: NodeJS.ProcessEnv = { [LINK_CODE_ENV]: 'from-env@cloud.example' }
  expect(takeSetupLinkCode('from-flag@cloud.example', env)).toBe('from-flag@cloud.example')
  expect(LINK_CODE_ENV in env).toBe(false)
})

test('no flag and an empty variable give no code', () => {
  expect(takeSetupLinkCode(undefined, { [LINK_CODE_ENV]: '  ' })).toBeUndefined()
  expect(takeSetupLinkCode(undefined, {})).toBeUndefined()
})
