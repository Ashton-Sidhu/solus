import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { link, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyProjectFileMutation } from '@solus/server/files/project-mutations'

// WHY: a project-relative create, rename, or delete must stay in the project.
// A link inside the project is an ordinary entry there; it must not carry the
// edit to the folder it points to. The general file save is a separate path
// and may still write outside the project on purpose.

let base: string
let root: string
let outside: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'solus-file-links-'))
  root = join(base, 'project')
  outside = join(base, 'outside')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(root, 'src', 'index.ts'), 'export {}\n')
  await writeFile(join(outside, 'keep.txt'), 'outside file\n')
  await symlink(outside, join(root, 'linked'))
  await symlink(join(root, 'src'), join(root, 'alias'))
  await symlink(join(base, 'gone'), join(root, 'dangling'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const exists = (path: string) => lstat(path).then(() => true, () => false)
const outsideError = (path: string) => ({ ok: false, error: `File path is outside the repository: ${path}` })

describe('a link in the middle of the path that leads out of the project', () => {
  test('refuses a create, and nothing appears outside', async () => {
    expect(await applyProjectFileMutation(root, { op: 'createFile', path: 'linked/new.txt' })).toEqual(outsideError('linked/new.txt'))
    expect(await applyProjectFileMutation(root, { op: 'createFolder', path: 'linked/new/' })).toEqual(outsideError('linked/new/'))
    expect(await applyProjectFileMutation(root, { op: 'createFile', path: 'linked/missing/new.txt' })).toEqual(outsideError('linked/missing/new.txt'))
    expect(await exists(join(outside, 'new.txt'))).toBe(false)
    expect(await exists(join(outside, 'new'))).toBe(false)
    expect(await exists(join(outside, 'missing'))).toBe(false)
  })

  test('refuses a delete, and the outside file stays', async () => {
    expect(await applyProjectFileMutation(root, { op: 'delete', path: 'linked/keep.txt' })).toEqual(outsideError('linked/keep.txt'))
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside file\n')
  })

  test('refuses a rename out of it or into it', async () => {
    expect(await applyProjectFileMutation(root, { op: 'rename', path: 'linked/keep.txt', toPath: 'src/taken.txt' }))
      .toEqual(outsideError('linked/keep.txt'))
    expect(await applyProjectFileMutation(root, { op: 'rename', path: 'src/index.ts', toPath: 'linked/moved.ts' }))
      .toEqual(outsideError('linked/moved.ts'))
    expect(await exists(join(outside, 'moved.ts'))).toBe(false)
    expect(await exists(join(root, 'src', 'index.ts'))).toBe(true)
    expect(await exists(join(outside, 'keep.txt'))).toBe(true)
  })

  test('refuses a link that climbs above the project', async () => {
    await symlink('..', join(root, 'up'))
    expect(await applyProjectFileMutation(root, { op: 'createFile', path: 'up/escape.txt' })).toEqual(outsideError('up/escape.txt'))
    expect(await exists(join(base, 'escape.txt'))).toBe(false)
  })
})

describe('a link as the final name', () => {
  test('a delete removes the link, not the folder it points to', async () => {
    expect(await applyProjectFileMutation(root, { op: 'delete', path: 'linked' })).toEqual({ ok: true, path: '' })
    expect(await exists(join(root, 'linked'))).toBe(false)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside file\n')
  })

  test('a rename moves the link itself', async () => {
    expect(await applyProjectFileMutation(root, { op: 'rename', path: 'linked', toPath: 'src/outside-link' }))
      .toEqual({ ok: true, path: 'src/outside-link' })
    expect(await readlink(join(root, 'src', 'outside-link'))).toBe(outside)
    expect(await exists(join(outside, 'keep.txt'))).toBe(true)
  })

  test('a create finds the name taken', async () => {
    expect(await applyProjectFileMutation(root, { op: 'createFile', path: 'linked' }))
      .toEqual({ ok: false, error: 'Something with that name already exists here.' })
  })
})

describe('a link whose target is gone', () => {
  test('a create beneath it is refused, and its target is not created', async () => {
    const result = await applyProjectFileMutation(root, { op: 'createFile', path: 'dangling/new.txt' })
    expect(result).toEqual({ ok: false, error: 'That location no longer exists.' })
    expect(await exists(join(base, 'gone'))).toBe(false)
  })

  test('the link itself can be deleted', async () => {
    expect(await applyProjectFileMutation(root, { op: 'delete', path: 'dangling' })).toEqual({ ok: true, path: '' })
    expect(await exists(join(root, 'dangling'))).toBe(false)
  })

  test('a rename onto it is refused: the name is taken', async () => {
    expect(await applyProjectFileMutation(root, { op: 'rename', path: 'src/index.ts', toPath: 'dangling' }))
      .toEqual({ ok: false, error: 'Something with that name already exists here.' })
    expect(await exists(join(root, 'src', 'index.ts'))).toBe(true)
    expect((await lstat(join(root, 'dangling'))).isSymbolicLink()).toBe(true)
  })
})

describe('a link that stays inside the project', () => {
  test('creates, renames, and deletes through it', async () => {
    expect(await applyProjectFileMutation(root, { op: 'createFile', path: 'alias/deep/new.ts' }))
      .toEqual({ ok: true, path: 'alias/deep/new.ts' })
    expect(await readFile(join(root, 'src', 'deep', 'new.ts'), 'utf8')).toBe('')
    expect(await applyProjectFileMutation(root, { op: 'rename', path: 'alias/index.ts', toPath: 'alias/main.ts' }))
      .toEqual({ ok: true, path: 'alias/main.ts' })
    expect(await exists(join(root, 'src', 'main.ts'))).toBe(true)
    expect(await applyProjectFileMutation(root, { op: 'delete', path: 'alias/main.ts' })).toEqual({ ok: true, path: '' })
    expect(await exists(join(root, 'src', 'main.ts'))).toBe(false)
  })

  test('a project root given through a link is the same project', async () => {
    const linkedRoot = join(base, 'project-link')
    await symlink(root, linkedRoot)
    expect(await applyProjectFileMutation(linkedRoot, { op: 'createFile', path: 'src/through-root-link.ts' }))
      .toEqual({ ok: true, path: 'src/through-root-link.ts' })
    expect(await exists(join(root, 'src', 'through-root-link.ts'))).toBe(true)
  })
})

// WHY: a rename never replaces another entry. Two names for one file are two
// entries: comparing where they lead would let one silently replace the other.
describe('a rename onto another name for the same file', () => {
  const taken = { ok: false, error: 'Something with that name already exists here.' }

  test('two links to one target stay two links', async () => {
    await symlink(outside, join(root, 'second-link'))
    expect(await applyProjectFileMutation(root, { op: 'rename', path: 'linked', toPath: 'second-link' })).toEqual(taken)
    expect(await readlink(join(root, 'linked'))).toBe(outside)
    expect(await readlink(join(root, 'second-link'))).toBe(outside)
  })

  test('a file does not replace a link to itself', async () => {
    await symlink(join(root, 'src', 'index.ts'), join(root, 'src', 'index-link.ts'))
    expect(await applyProjectFileMutation(root, { op: 'rename', path: 'src/index.ts', toPath: 'src/index-link.ts' })).toEqual(taken)
    expect(await readFile(join(root, 'src', 'index.ts'), 'utf8')).toBe('export {}\n')
    expect(await readlink(join(root, 'src', 'index-link.ts'))).toBe(join(root, 'src', 'index.ts'))
  })

  test('a hard link to the file is another entry', async () => {
    await link(join(root, 'src', 'index.ts'), join(root, 'src', 'hard.ts'))
    expect(await applyProjectFileMutation(root, { op: 'rename', path: 'src/index.ts', toPath: 'src/hard.ts' })).toEqual(taken)
    expect(await exists(join(root, 'src', 'index.ts'))).toBe(true)
    expect(await exists(join(root, 'src', 'hard.ts'))).toBe(true)
  })

  test('a rename to its own name changes nothing', async () => {
    expect(await applyProjectFileMutation(root, { op: 'rename', path: 'src/index.ts', toPath: 'src/index.ts' }))
      .toEqual({ ok: true, path: 'src/index.ts' })
    expect(await readFile(join(root, 'src', 'index.ts'), 'utf8')).toBe('export {}\n')
  })
})

test('a case-only rename still works on a case-insensitive filesystem', async () => {
  const caseInsensitive = await stat(join(root, 'SRC', 'INDEX.TS')).then(() => true, () => false)
  if (!caseInsensitive) return
  expect(await applyProjectFileMutation(root, { op: 'rename', path: 'src/index.ts', toPath: 'src/Index.ts' }))
    .toEqual({ ok: true, path: 'src/Index.ts' })
  expect(await realpath(join(root, 'src', 'index.ts'))).toBe(join(await realpath(root), 'src', 'Index.ts'))
})
