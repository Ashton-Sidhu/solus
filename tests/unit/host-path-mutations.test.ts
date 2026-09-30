import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { configurePlatformServices } from '@solus/server/platform/services'
import { applyHostPathMutation } from '@solus/server/files/host-path-mutations'

let root: string
let trashed: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'solus-host-path-'))
  trashed = []
  configurePlatformServices({ trashItem: async (path) => void trashed.push(path) })
})

afterEach(() => {
  configurePlatformServices({})
  rmSync(root, { recursive: true, force: true })
})

describe('directory picker path edits', () => {
  test('delete from the picker goes to the Trash, not rm', async () => {
    // WHY: the picker reaches any folder on the host. A mis-tap must be
    // recoverable, so the first delete is always a move to the Trash.
    const folder = join(root, 'old')
    mkdirSync(folder)
    expect(await applyHostPathMutation({ op: 'trash', path: folder })).toEqual({ ok: true, path: '' })
    expect(trashed).toEqual([folder])
    expect(existsSync(folder)).toBe(true)
  })

  test('a host without a Trash says so and keeps the folder', async () => {
    // WHY: permanent delete must be a second, explicit choice by the user,
    // never a silent fallback.
    configurePlatformServices({ trashItem: async () => { throw new Error('no trash') } })
    const folder = join(root, 'old')
    mkdirSync(folder)
    const result = await applyHostPathMutation({ op: 'trash', path: folder })
    expect(result).toMatchObject({ ok: false, trashUnavailable: true })
    expect(existsSync(folder)).toBe(true)

    expect(await applyHostPathMutation({ op: 'delete', path: folder })).toEqual({ ok: true, path: '' })
    expect(existsSync(folder)).toBe(false)
  })

  test('home and the filesystem root cannot be removed', async () => {
    for (const path of ['~', homedir(), '/']) {
      expect(await applyHostPathMutation({ op: 'delete', path })).toMatchObject({ ok: false })
      expect(await applyHostPathMutation({ op: 'trash', path })).toMatchObject({ ok: false })
    }
    expect(trashed).toEqual([])
  })

  test('rename never replaces a folder that is already there', async () => {
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'b'))
    const taken = await applyHostPathMutation({ op: 'rename', path: join(root, 'a'), toPath: join(root, 'b') })
    expect(taken).toMatchObject({ ok: false })
    expect(existsSync(join(root, 'a'))).toBe(true)

    const renamed = await applyHostPathMutation({ op: 'rename', path: join(root, 'a'), toPath: join(root, 'c') })
    expect(renamed).toEqual({ ok: true, path: join(root, 'c') })
    expect(existsSync(join(root, 'c'))).toBe(true)
  })
})
