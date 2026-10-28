import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'

const { packageLayout } = createRequire(import.meta.url)('../../scripts/desktop-package-layout.cjs')
// The layout joins with the host separator, so each platform is checked on its own kind of host.
const posixHost = process.platform !== 'win32'

test.if(posixHost)('Linux probes and fuse changes target the executable outside resources', () => {
  expect(packageLayout({ appOutDir: '/output/linux', electronPlatformName: 'linux', packager: { executableName: 'solus', appInfo: { productFilename: 'Solus' } } })).toEqual({
    appPath: '/output/linux', resourcesDir: '/output/linux/resources', executable: '/output/linux/solus', fusePath: '/output/linux/solus',
  })
})

test.if(posixHost)('Mac runtime checks retain the app bundle layout', () => {
  expect(packageLayout({ appOutDir: '/output/mac', electronPlatformName: 'darwin', packager: { appInfo: { productFilename: 'Solus' } } })).toEqual({
    appPath: '/output/mac/Solus.app', resourcesDir: '/output/mac/Solus.app/Contents/Resources', executable: '/output/mac/Solus.app/Contents/MacOS/Solus', fusePath: '/output/mac/Solus.app',
  })
})

test.if(!posixHost)('Windows probes and fuse changes target Solus.exe beside resources', () => {
  expect(packageLayout({ appOutDir: 'C:\\output\\win-unpacked', electronPlatformName: 'win32', packager: { appInfo: { productFilename: 'Solus' } } })).toEqual({
    appPath: 'C:\\output\\win-unpacked', resourcesDir: 'C:\\output\\win-unpacked\\resources', executable: 'C:\\output\\win-unpacked\\Solus.exe', fusePath: 'C:\\output\\win-unpacked\\Solus.exe',
  })
})
