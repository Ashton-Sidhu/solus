import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RegistrySkillCache } from '@solus/server/skills/registry-skill-cache'

/**
 * A registry skill is downloaded once per host and read as files after
 * (plans/020-agent-profile.md §2). The profile pulls every few minutes for every
 * person, so a download per pull would run `npx` constantly; and a download that
 * did not produce the skill must not leave a cache that looks complete.
 */

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'registry-skills-'))
  roots.push(root)
  return join(root, 'cache')
}

/** The skills CLI as it lays a skill out under the home it is given. */
function fakeDownload(placed: (id: string) => string | null) {
  const calls: string[] = []
  const download = async (id: string, home: string) => {
    calls.push(id)
    const name = placed(id)
    if (!name) return
    const folder = join(home, '.claude', 'skills', name)
    mkdirSync(join(folder, 'scripts'), { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), `# ${name}`)
    writeFileSync(join(folder, 'scripts', 'run.sh'), 'echo run')
    chmodSync(join(folder, 'scripts', 'run.sh'), 0o755)
    writeFileSync(join(folder, '.DS_Store'), 'junk')
  }
  return { download, calls }
}

test('a skill is downloaded once and read from the cache after, with its executable bit and without hidden files', async () => {
  const { download, calls } = fakeDownload(() => 'grill-me')
  const cache = new RegistrySkillCache(cacheRoot(), download)
  const [first, second] = await Promise.all([cache.files('mattpocock/skills@grill-me', 'grill-me'), cache.files('mattpocock/skills@grill-me', 'grill-me')])
  const again = await cache.files('mattpocock/skills@grill-me', 'grill-me')
  expect(calls).toEqual(['mattpocock/skills@grill-me'])
  for (const files of [first, second, again]) {
    expect(files.map((file) => [file.path, file.content.toString(), file.executable])).toEqual([
      ['SKILL.md', '# grill-me', false],
      ['scripts/run.sh', 'echo run', true],
    ])
  }
})

test('a download that does not produce the skill fails and is tried again next time', async () => {
  let works = false
  const { download, calls } = fakeDownload(() => works ? 'grill-me' : null)
  const cache = new RegistrySkillCache(cacheRoot(), download)
  await expect(cache.files('mattpocock/skills@grill-me', 'grill-me')).rejects.toThrow('did not place "grill-me"')
  works = true
  expect((await cache.files('mattpocock/skills@grill-me', 'grill-me')).map((file) => file.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
  expect(calls).toHaveLength(2)
})
