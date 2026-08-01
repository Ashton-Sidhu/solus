import { afterEach, describe, expect, test } from 'bun:test'
import { isPackagedRuntime } from '../../src/main/platform/paths'

const originalInstallDir = process.env.SOLUS_INSTALL_DIR

afterEach(() => {
  if (originalInstallDir === undefined) delete process.env.SOLUS_INSTALL_DIR
  else process.env.SOLUS_INSTALL_DIR = originalInstallDir
})

describe('packaged runtime detection', () => {
  test('recognizes the installed standalone server launcher', () => {
    process.env.SOLUS_INSTALL_DIR = '/opt/solus'
    expect(isPackagedRuntime()).toBe(true)
  })
})
