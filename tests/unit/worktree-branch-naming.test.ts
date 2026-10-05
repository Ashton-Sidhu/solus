import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_WORKTREE_BRANCH_NAMING,
  cleanBranchName,
  generatedWorktreeBranchName,
  initialWorktreeBranchName,
  isValidBranchName,
  temporaryWorktreeBranchId,
  worktreeBranchNamingError,
  worktreeBranchPreview,
  type WorktreeBranchNaming,
} from '@solus/contracts/worktree-branch-naming'

const ID = '0a1b2c3d'
const TITLE = 'Fix Login Redirect'

function namer(naming: Partial<WorktreeBranchNaming>, user: string | null = null) {
  return { naming: { ...DEFAULT_WORKTREE_BRANCH_NAMING, ...naming }, user }
}

describe('generated mode', () => {
  test('starts on <prefix>/<id> and is renamed to <prefix>/<slug>', () => {
    // WHY: the default must stay today's behaviour, so existing users see no change.
    const generated = namer({})
    const temporary = initialWorktreeBranchName(generated, ID)
    expect(temporary).toBe(`solus/${ID}`)
    expect(temporaryWorktreeBranchId(temporary, generated)).toBe(ID)
    expect(generatedWorktreeBranchName(TITLE, generated, ID)).toBe('solus/fix-login-redirect')
  })

  test('uses the configured prefix for both names', () => {
    const team = namer({ prefix: 'team/web' })
    expect(initialWorktreeBranchName(team, ID)).toBe(`team/web/${ID}`)
    expect(generatedWorktreeBranchName(TITLE, team, ID)).toBe('team/web/fix-login-redirect')
    // A branch from another prefix is not this naming's temporary branch.
    expect(temporaryWorktreeBranchId(`solus/${ID}`, team)).toBeNull()
  })

  test('a title with no usable word keeps the temporary branch', () => {
    expect(generatedWorktreeBranchName('???', namer({}), ID)).toBeNull()
  })
})

describe('static mode', () => {
  test('the first name is final, so no model is asked and nothing is renamed', () => {
    const fixed = namer({ mode: 'static', prefix: 'agent' })
    const branch = initialWorktreeBranchName(fixed, ID)
    expect(branch).toBe(`agent/${ID}`)
    expect(temporaryWorktreeBranchId(branch, fixed)).toBeNull()
    expect(generatedWorktreeBranchName(TITLE, fixed, ID)).toBeNull()
  })
})

describe('custom mode', () => {
  test('fills {prefix}, {user}, and {slug}', () => {
    const custom = namer({ mode: 'custom', template: '{prefix}/{user}/{slug}' }, 'ada')
    expect(initialWorktreeBranchName(custom, ID)).toBe(`solus/ada/${ID}`)
    expect(generatedWorktreeBranchName(TITLE, custom, ID)).toBe('solus/ada/fix-login-redirect')
  })

  test('a template with {id} and {slug} keeps the temporary id after the rename', () => {
    const custom = namer({ mode: 'custom', template: 'wip/{id}-{slug}' })
    const temporary = initialWorktreeBranchName(custom, ID)
    expect(temporary).toBe(`wip/${ID}-${ID}`)
    const id = temporaryWorktreeBranchId(temporary, custom)
    expect(id).toBe(ID)
    expect(generatedWorktreeBranchName(TITLE, custom, id!)).toBe(`wip/${ID}-fix-login-redirect`)
  })

  test('a template without {slug} is final at creation', () => {
    const custom = namer({ mode: 'custom', template: '{user}/{id}' }, 'ada')
    expect(initialWorktreeBranchName(custom, ID)).toBe(`ada/${ID}`)
    expect(temporaryWorktreeBranchId(`ada/${ID}`, custom)).toBeNull()
  })

  test('a missing git user drops the token instead of failing the name', () => {
    const custom = namer({ mode: 'custom', template: '{user}/{slug}' }, null)
    expect(initialWorktreeBranchName(custom, ID)).toBe(ID)
    expect(generatedWorktreeBranchName(TITLE, custom, ID)).toBe('fix-login-redirect')
  })
})

describe('invalid templates fall back to the default', () => {
  test.each([
    ['{prefix}/{branch}', 'Unknown token {branch}'],
    ['', 'Enter a template.'],
    ['@', 'not make a valid'],
  ])('%p', (template, error) => {
    // WHY: a typo in Settings must never leave a session without a branch.
    const broken = namer({ mode: 'custom', template })
    expect(worktreeBranchNamingError(broken.naming)).toContain(error)
    expect(initialWorktreeBranchName(broken, ID)).toBe(`solus/${ID}`)
    expect(generatedWorktreeBranchName(TITLE, broken, ID)).toBe('solus/fix-login-redirect')
    expect(worktreeBranchPreview(broken.naming)).toBe('solus/fix-login-redirect')
  })
})

describe('ref-name sanitization', () => {
  test('cleans what git refuses', () => {
    expect(cleanBranchName('My Team../x')).toBe('My-Team/x')
    expect(cleanBranchName('.hidden/a.lock/b~c^d:e')).toBe('hidden/a/b-c-d-e')
    expect(cleanBranchName('//a//b//')).toBe('a/b')
    expect(cleanBranchName('a@{b}')).toBe('a-b}')
  })

  test('a prefix with spaces and dots still makes a valid branch', () => {
    const branch = initialWorktreeBranchName(namer({ prefix: ' My Team.. ' }), ID)
    expect(branch).toBe(`My-Team/${ID}`)
    expect(isValidBranchName(branch)).toBe(true)
  })

  test('validates with git ref-name rules', () => {
    for (const valid of ['solus/fix', 'a/b-c.d', 'feature/ADA/x']) expect(isValidBranchName(valid)).toBe(true)
    for (const invalid of ['', '@', '-x', 'a..b', 'a//b', 'a/', 'a.', '.a', 'a/.b', 'a.lock', 'a b', 'a~b', 'a@{b', 'HEAD']) {
      expect(isValidBranchName(invalid)).toBe(false)
    }
  })
})

describe('collision suffix', () => {
  test('a temporary branch with a collision suffix is still renamed', () => {
    // WHY: `availableBranchName` adds `-2` when the name is taken; that branch
    // is still temporary and must still get its generated name.
    expect(temporaryWorktreeBranchId(`solus/${ID}-2`, namer({}))).toBe(ID)
    expect(temporaryWorktreeBranchId('solus/fix-login-redirect-2', namer({}))).toBeNull()
  })
})

describe('per-project override', () => {
  const previousDataDir = process.env.SOLUS_DATA_DIR
  const directories: string[] = []
  let resolveWorktreeBranchNamer: typeof import('@solus/server/git/worktree-branch-name')['resolveWorktreeBranchNamer']
  let setHostConfig: typeof import('@solus/server/host/settings')['setHostConfig']
  // The person's own naming preference (plans/018 §3.3), sent with their work.
  const personal = { mode: 'static', prefix: 'mine', template: '{prefix}/{slug}' } as const

  beforeAll(async () => {
    // Host config is persisted; the live ~/.solus must stay untouched.
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-branch-naming-data-'))
    directories.push(dataDir)
    process.env.SOLUS_DATA_DIR = dataDir
    ;({ setHostConfig } = await import('@solus/server/host/settings'))
    ;({ resolveWorktreeBranchNamer } = await import('@solus/server/git/worktree-branch-name'))
    // What another person once wrote to this host. It must name nobody's branch.
    setHostConfig({ worktreeBranchNaming: { mode: 'static', prefix: 'host', template: '{prefix}/{slug}' } })
  })

  afterAll(() => {
    process.env.SOLUS_DATA_DIR = previousDataDir
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  })

  function project(config?: object): string {
    const directory = mkdtempSync(join(tmpdir(), 'solus-branch-naming-project-'))
    directories.push(directory)
    if (config) {
      mkdirSync(join(directory, '.solus'))
      writeFileSync(join(directory, '.solus', 'config.json'), JSON.stringify(config))
    }
    return directory
  }

  test("a project without an override uses the person's preference, never the host's config", async () => {
    expect((await resolveWorktreeBranchNamer(project(), personal)).naming).toEqual(personal)
    // No preference sent: the built-in default, not what the host config holds.
    expect((await resolveWorktreeBranchNamer(project(), undefined)).naming.prefix).not.toBe('host')
  })

  test("the project's override wins over the person's preference", async () => {
    // WHY: branch naming is a team convention, committed with the repository.
    const override = { mode: 'generated', prefix: 'team', template: '{prefix}/{slug}' }
    const resolved = await resolveWorktreeBranchNamer(project({ worktreeBranchNaming: override }), personal)
    expect(resolved.naming).toEqual(override)
    expect(initialWorktreeBranchName(resolved, ID)).toBe(`team/${ID}`)
  })

  test('a malformed override is ignored, not fatal', async () => {
    const { naming } = await resolveWorktreeBranchNamer(project({ worktreeBranchNaming: { mode: 'fancy' } }), personal)
    expect(naming.prefix).toBe('mine')
  })
})
