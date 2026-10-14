import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { androidBuildAppId } from '@solus/server/devices/device-app-id'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

test('the built variant app id comes from Gradle metadata, so Debug suffixes are preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solus-app-id-'))
  roots.push(root)
  await writeFile(join(root, 'output-metadata.json'), JSON.stringify({ applicationId: 'dev.example.app.debug' }))
  const result = await androidBuildAppId(join(root, 'app-debug.apk'), null, async () => { throw new Error('No SDK probe is needed') })
  expect(result).toBe('dev.example.app.debug')
})

test('an APK manifest is the fallback when metadata is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solus-app-id-'))
  roots.push(root)
  const tools = join(root, 'build-tools', '36.0.0')
  await mkdir(tools, { recursive: true })
  await writeFile(join(tools, process.platform === 'win32' ? 'aapt.exe' : 'aapt'), '')
  const result = await androidBuildAppId(join(root, 'app.apk'), root, async (_command, args) => {
    expect(args).toEqual(['dump', 'badging', join(root, 'app.apk')])
    return { code: 0, stdout: "package: name='dev.example.app' versionCode='1'", stderr: '' }
  })
  expect(result).toBe('dev.example.app')
})
