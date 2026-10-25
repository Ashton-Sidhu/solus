import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { compileCacheDir, startCompileCache, type CompileCacheHost } from '@solus/desktop-main/compile-cache'

const host = (overrides: Partial<CompileCacheHost>): CompileCacheHost => ({
  platform: 'darwin',
  xdgCacheHome: undefined,
  homeDir: () => '/home/ada',
  tempDir: () => '/var/folders/ab/T',
  ...overrides,
})

describe('desktop compile cache dir', () => {
  test('macOS and Windows use the per-user temp dir', () => {
    expect(compileCacheDir(host({ platform: 'darwin' }))).toBe(join('/var/folders/ab/T', 'solus', 'compile-cache'))
    expect(compileCacheDir(host({ platform: 'win32', tempDir: () => '/Users/ada/AppData/Local/Temp' })))
      .toBe(join('/Users/ada/AppData/Local/Temp', 'solus', 'compile-cache'))
  })

  test('Linux stays out of the shared /tmp', () => {
    const linux = host({ platform: 'linux', tempDir: () => '/tmp' })
    expect(compileCacheDir(linux)).toBe(join('/home/ada/.cache', 'solus', 'compile-cache'))
    expect(compileCacheDir({ ...linux, xdgCacheHome: '/xdg/cache' })).toBe(join('/xdg/cache', 'solus', 'compile-cache'))
    expect(compileCacheDir({ ...linux, xdgCacheHome: '' })).toBe(join('/home/ada/.cache', 'solus', 'compile-cache'))
  })
})

describe('desktop compile cache start', () => {
  test('a packaged launch enables the cache in the resolved dir', () => {
    const enabled: string[] = []
    startCompileCache(true, (directory) => enabled.push(directory), host({}))
    expect(enabled).toEqual([join('/var/folders/ab/T', 'solus', 'compile-cache')])
  })

  test('a dev launch never enables the cache', () => {
    const enabled: string[] = []
    startCompileCache(false, (directory) => enabled.push(directory), host({}))
    expect(enabled).toEqual([])
  })

  test('a cache failure never blocks launch', () => {
    expect(() => startCompileCache(true, () => { throw new Error('EACCES') }, host({}))).not.toThrow()
    expect(() => startCompileCache(true, () => {}, host({ homeDir: () => { throw new Error('no home') }, platform: 'linux' }))).not.toThrow()
  })
})
