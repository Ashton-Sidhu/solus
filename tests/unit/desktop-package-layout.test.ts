import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'

const { packageLayout } = createRequire(import.meta.url)('../../scripts/desktop-package-layout.cjs')

test('Linux probes and fuse changes target the executable outside resources', () => {
  expect(packageLayout({ appOutDir: '/output/linux', electronPlatformName: 'linux', packager: { executableName: 'solus', appInfo: { productFilename: 'Solus' } } })).toEqual({
    appPath: '/output/linux', resourcesDir: '/output/linux/resources', executable: '/output/linux/solus', fusePath: '/output/linux/solus',
  })
})

test('Mac runtime checks retain the app bundle layout', () => {
  expect(packageLayout({ appOutDir: '/output/mac', electronPlatformName: 'darwin', packager: { appInfo: { productFilename: 'Solus' } } })).toEqual({
    appPath: '/output/mac/Solus.app', resourcesDir: '/output/mac/Solus.app/Contents/Resources', executable: '/output/mac/Solus.app/Contents/MacOS/Solus', fusePath: '/output/mac/Solus.app',
  })
})
