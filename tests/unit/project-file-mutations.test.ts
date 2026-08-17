import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyProjectFileMutation } from '../../src/main/server/handlers/lib/project-mutations'

let root: string

beforeEach(async () => {
  // realpath-free tmp dirs differ from the root the handler receives on macOS
  // (/var -> /private/var); the handler is given the resolved root, as the
  // server does, so the test exercises the same paths the app does.
  root = await mkdtemp(join(tmpdir(), 'solus-files-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'index.ts'), 'export {}\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const exists = (path: string) => stat(join(root, path)).then(() => true).catch(() => false)

describe('creating', () => {
  test('a new file starts empty and is reported at its root-relative path', async () => {
    const result = await applyProjectFileMutation(root, { op: 'createFile', path: 'src/new.ts' })
    expect(result).toEqual({ ok: true, path: 'src/new.ts' })
    expect(await readFile(join(root, 'src/new.ts'), 'utf-8')).toBe('')
  })

  test('a folder path keeps its trailing slash in the answer, so the tree draws a folder', async () => {
    const result = await applyProjectFileMutation(root, { op: 'createFolder', path: 'src/lib/' })
    expect(result).toEqual({ ok: true, path: 'src/lib/' })
    expect(await exists('src/lib')).toBe(true)
  })

  test('an empty folder created just now can be deleted again', async () => {
    await applyProjectFileMutation(root, { op: 'createFolder', path: 'src/lib/' })
    const result = await applyProjectFileMutation(root, { op: 'delete', path: 'src/lib/' })
    expect(result).toEqual({ ok: true, path: '' })
    expect(await exists('src/lib')).toBe(false)
  })

  test('creating never clobbers a file that is already there', async () => {
    const result = await applyProjectFileMutation(root, { op: 'createFile', path: 'src/index.ts' })
    expect(result).toEqual({ ok: false, error: 'Something with that name already exists here.' })
    expect(await readFile(join(root, 'src/index.ts'), 'utf-8')).toBe('export {}\n')
  })

  test('a folder committed under its placeholder name is on disk, so it can be renamed after', async () => {
    await applyProjectFileMutation(root, { op: 'createFolder', path: 'untitled folder/' })
    const renamed = await applyProjectFileMutation(root, {
      op: 'rename',
      path: 'untitled folder/',
      toPath: 'notes/',
    })
    expect(renamed).toEqual({ ok: true, path: 'notes/' })
    expect(await exists('notes')).toBe(true)
  })
})

describe('renaming', () => {
  test('a folder takes its contents with it', async () => {
    await applyProjectFileMutation(root, { op: 'rename', path: 'src/', toPath: 'core/' })
    expect(await exists('core/index.ts')).toBe(true)
    expect(await exists('src')).toBe(false)
  })

  test('an occupied destination is refused rather than overwritten', async () => {
    await writeFile(join(root, 'src', 'taken.ts'), 'keep me\n')
    const result = await applyProjectFileMutation(root, {
      op: 'rename',
      path: 'src/index.ts',
      toPath: 'src/taken.ts',
    })
    expect(result.ok).toBe(false)
    expect(await readFile(join(root, 'src/taken.ts'), 'utf-8')).toBe('keep me\n')
  })
})

describe('deleting', () => {
  test('a folder goes with everything under it', async () => {
    const result = await applyProjectFileMutation(root, { op: 'delete', path: 'src/' })
    expect(result.ok).toBe(true)
    expect(await exists('src')).toBe(false)
  })

  test('an entry something else already removed still ends up gone, not an error', async () => {
    const result = await applyProjectFileMutation(root, { op: 'delete', path: 'src/gone.ts' })
    expect(result).toEqual({ ok: true, path: '' })
  })
})

describe('staying inside the project', () => {
  test('a path climbing out of the root is refused before it reaches the filesystem', async () => {
    const result = await applyProjectFileMutation(root, { op: 'delete', path: '../escape' })
    expect(result).toEqual({ ok: false, error: 'File path is outside the repository: ../escape' })
  })
})
