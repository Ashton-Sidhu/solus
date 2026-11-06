import { describe, expect, test } from 'bun:test'
import { buildResourceMonitor, resourceMonitorRustTarget } from '../../scripts/build-resource-monitor'

describe('the resource monitor build', () => {
  test('a Linux target is static musl, so one binary runs on glibc and musl hosts', () => {
    expect(resourceMonitorRustTarget({ platform: 'linux', arch: 'x64' })).toBe('x86_64-unknown-linux-musl')
    expect(resourceMonitorRustTarget({ platform: 'linux', arch: 'arm64' })).toBe('aarch64-unknown-linux-musl')
  })

  test('each packaged host has a target', () => {
    expect(resourceMonitorRustTarget({ platform: 'darwin', arch: 'arm64' })).toBe('aarch64-apple-darwin')
    expect(resourceMonitorRustTarget({ platform: 'win32', arch: 'x64' })).toBe('x86_64-pc-windows-msvc')
  })

  test('a macOS or Windows binary is built on that system, and says so before it starts', () => {
    expect(() => buildResourceMonitor({ platform: 'darwin', arch: 'arm64' }, 'linux')).toThrow('on darwin')
    expect(() => buildResourceMonitor({ platform: 'win32', arch: 'x64' }, 'darwin')).toThrow('on win32')
  })
})
