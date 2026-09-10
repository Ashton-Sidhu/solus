import { describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FileMatcher, getFileMatchers } from 'app-builder-lib/out/fileMatcher'
import type { Configuration } from 'electron-builder'

const root = resolve(import.meta.dir, '../..')
const { build }: { build: Configuration } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const fileStat = statSync(import.meta.filename)
const expandMacros = (pattern: string) => pattern.replaceAll('${arch}', 'arm64')

describe('desktop package contents', () => {
  test('Mac packaging keeps the app file allowlist and excludes workspace data', () => {
    const matchers = getFileMatchers(build, 'files', '/package', {
      macroExpander: expandMacros,
      customBuildOptions: build.mac ?? {},
      globalOutDir: '/package',
      defaultSrc: root,
    })
    expect(matchers).not.toBeNull()
    const matcher = matchers![0]
    // An exclusion-only platform override makes electron-builder include **/*.
    expect(matcher.containsOnlyIgnore()).toBe(false)
    const includes = matcher.createFilter()
    for (const name of ['dist/main/index.js', 'dist/renderer/index.html', 'dist/client/index.html', 'dist/preload/index.js', 'resources/plugins/solus/plugin.json', 'package.json']) {
      expect(includes(join(root, name), fileStat)).toBe(true)
    }
    for (const name of ['.env', '.solus-local/solus.db', 'dev.log', 'release/old.app/Contents/Resources/app.asar', 'packages/server/src/control-plane.ts', 'dist/main/index.js.map']) {
      expect(includes(join(root, name), fileStat)).toBe(false)
    }
  })

  test('native filters keep the Mac binding and linked library without extra runtimes', () => {
    // electron-builder's node-module collector applies the negative file rules
    // to its production dependency tree separately from the app file allowlist.
    const rules = [build.files, build.mac?.files].flat().filter((rule): rule is string => typeof rule === 'string' && rule.startsWith('!'))
    const includes = new FileMatcher(root, '/package', expandMacros, ['**/*', ...rules]).createFilter()
    for (const name of [
      '@anthropic-ai/claude-agent-sdk/sdk.mjs',
      'onnxruntime-node/dist/index.js',
      'onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
      'onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib',
      '@ff-labs/fff-bin-darwin-arm64/libfff_c.dylib',
    ]) {
      expect(includes(join(root, 'node_modules', name), fileStat)).toBe(true)
    }
    for (const name of [
      '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
      '@anthropic-ai/claude-agent-sdk-linux-x64/claude',
      'onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.29.0.dylib',
      'onnxruntime-node/bin/napi-v6/darwin/x64/libonnxruntime.1.dylib',
      'onnxruntime-node/bin/napi-v6/linux/arm64/libonnxruntime.so.1',
      'onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1',
      'onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll',
      'onnxruntime-node/dist/index.js.map',
    ]) {
      expect(includes(join(root, 'node_modules', name), fileStat)).toBe(false)
    }
  })
})
