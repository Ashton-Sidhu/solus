import { describe, expect, mock, test } from 'bun:test'
import { homedir } from 'os'
import { parse } from 'path'

const create = mock(() => ({ ok: false, error: 'Native indexing must not start for a broad root' }))
mock.module('@ff-labs/fff-node', () => ({ FileFinder: { create } }))
const { getFinder, getContentFinder } = await import('@solus/server/server/file-finder')

describe('all index entry points reject broad roots before native creation', () => {
  test('path finder rejects home and filesystem root', async () => {
    expect(await getFinder(homedir())).toBeNull()
    expect(await getFinder(parse(homedir()).root)).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })
  test('content finder rejects home and filesystem root', async () => {
    expect(await getContentFinder(homedir() + '/')).toBeNull()
    expect(await getContentFinder(parse(homedir()).root)).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })
})
