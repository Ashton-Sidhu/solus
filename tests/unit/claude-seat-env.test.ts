import { afterEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeConfigDir, claudeEnv } from '@solus/server/execution/agents/claude/claude-agent'

// Step 2 plan §3.3 step 4: a member's turn runs on their own login and on nothing the
// host process carries; the host's own turns are unchanged.

const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.CLAUDE_CODE_OAUTH_TOKEN, dir: process.env.CLAUDE_CONFIG_DIR }
afterEach(() => {
  for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['CLAUDE_CODE_OAUTH_TOKEN', saved.token], ['CLAUDE_CONFIG_DIR', saved.dir]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('claudeEnv', () => {
  test('a seat replaces the host login and drops the host\'s API key and token', () => {
    process.env.ANTHROPIC_API_KEY = 'host-key'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'host-token'
    process.env.CLAUDE_CONFIG_DIR = '/host/.claude'
    const env = claudeEnv({ home: '/seats/claude/bob' })
    expect(env.CLAUDE_CONFIG_DIR).toBe('/seats/claude/bob')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('0')
  })

  test('a token seat carries its own token, and nothing else', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'host-token'
    const env = claudeEnv({ home: '/seats/claude/bob', envToken: 'bob-token' })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('bob-token')
  })

  test('without a seat the host process env passes through', () => {
    process.env.ANTHROPIC_API_KEY = 'host-key'
    process.env.CLAUDE_CONFIG_DIR = '/host/.claude'
    const env = claudeEnv()
    expect(env.ANTHROPIC_API_KEY).toBe('host-key')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/host/.claude')
  })
})

// The `/` menu lists the skills of the folder the caller's CLI reads, not the host's.
describe('claudeConfigDir', () => {
  test('a member who is their own Linux user reads the `.claude` in their own home', () => {
    process.env.CLAUDE_CONFIG_DIR = '/data/home/.claude'
    const dir = claudeConfigDir({ home: '/run/solus-seats/claude/ada', env: { HOME: '/data/members/ada' }, user: { uid: 20000 } })
    expect(dir).toBe('/data/members/ada/.claude')
  })

  test('a member seat without its own user reads the seat home', () => {
    expect(claudeConfigDir({ home: '/seats/claude/bob' })).toBe('/seats/claude/bob')
  })

  test('the host login reads the host\'s CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    process.env.CLAUDE_CONFIG_DIR = '/host/.claude'
    expect(claudeConfigDir({ home: '/ignored', isHostLogin: true })).toBe('/host/.claude')
    delete process.env.CLAUDE_CONFIG_DIR
    expect(claudeConfigDir()).toBe(join(process.env.HOME ?? homedir(), '.claude'))
  })
})

