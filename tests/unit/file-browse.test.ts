import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join, parse } from 'path'
import { browseFileMatches } from '@solus/server/server/handlers/lib/file-browse'
import { resolveIndexRoot } from '@solus/server/server/index-root'

let fixture: string
let workspace: string
beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'solus-file-browse-'))
  workspace = join(fixture, '.solus', 'my-workspace')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(fixture, 'Documents', 'nested'), { recursive: true })
  await writeFile(join(fixture, 'Documents', 'direct.txt'), '')
  await writeFile(join(fixture, 'Documents', 'nested', 'deep.txt'), '')
  await writeFile(join(fixture, 'Documents', '.hidden'), '')
  await symlink(homedir(), join(fixture, 'home-link'))
})
afterAll(async () => { await rm(fixture, { recursive: true, force: true }) })

describe('path autocomplete stays shallow', () => {
  test('external partial paths match only immediate children', async () => {
    const matches = await browseFileMatches(join(fixture, 'D'), workspace)
    expect(matches?.map(match => match.path)).toEqual([join(fixture, 'Documents')])
  })
  test('existing external directories never include grandchildren', async () => {
    const matches = await browseFileMatches(join(fixture, 'Documents'), workspace)
    expect(matches?.map(match => match.path)).toEqual([
      join(fixture, 'Documents', 'nested'), join(fixture, 'Documents', 'direct.txt'),
    ])
  })
  test('relative paths outside the workspace are shallow too', async () => {
    const matches = await browseFileMatches('../../Documents/dir', workspace)
    expect(matches?.map(match => match.path)).toEqual([join(fixture, 'Documents', 'direct.txt')])
  })
  test('root and home queries use browsing, not the index fallback', async () => {
    expect(await browseFileMatches('/U', workspace)).not.toBeNull()
    expect(await browseFileMatches('~/D', workspace)).not.toBeNull()
  })
  test('plain project queries retain indexed search', async () => {
    expect(await browseFileMatches('component', workspace)).toBeNull()
  })
  test('missing directories return no suggestions', async () => {
    expect(await browseFileMatches(join(fixture, 'missing') + '/', workspace)).toEqual([])
  })
})

describe('recursive index root limits', () => {
  test('rejects home, filesystem root, and normalized aliases', async () => {
    for (const root of [homedir(), homedir() + '/', join(homedir(), '.solus', '..'), parse(homedir()).root]) {
      expect(await resolveIndexRoot(root)).toBeNull()
    }
  })
  test('rejects a symlink to home', async () => {
    expect(await resolveIndexRoot(join(fixture, 'home-link'))).toBeNull()
  })
  test('allows a workspace nested beneath a hidden directory', async () => {
    expect(await resolveIndexRoot(workspace)).toBe(await realpath(workspace))
  })
})
