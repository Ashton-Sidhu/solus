import { describe, expect, test } from 'bun:test'
import { CODE_INTEL_ADAPTERS } from '@solus/server/code-intel/adapters'
import { installCodeIntelTool } from '@solus/server/code-intel/tool-installer'

const typescript = CODE_INTEL_ADAPTERS.find((adapter) => adapter.language === 'typescript')!

describe('code-intelligence tool installation', () => {
  test('runs only the fixed installer argv from the adapter allowlist', async () => {
    let installed = false
    let invocation: { binary: string; args: string[] } | null = null

    await installCodeIntelTool(typescript, {
      resolveBinary: (name) => (name === 'npm' ? '/host/bin/npm' : null),
      resolveTool: () => (installed ? '/host/bin/scip-typescript' : null),
      run: async (binary, args) => {
        invocation = { binary, args }
        installed = true
      },
    })

    // WHY: the client sends only a language enum. It must never be able to
    // turn this host-side install button into arbitrary command execution.
    expect(invocation).toEqual({
      binary: '/host/bin/npm',
      args: ['install', '-g', '@sourcegraph/scip-typescript'],
    })
  })

  test('does not reinstall a tool that is already available', async () => {
    let runCount = 0
    await installCodeIntelTool(typescript, {
      resolveBinary: () => '/host/bin/npm',
      resolveTool: () => '/host/bin/scip-typescript',
      run: async () => {
        runCount += 1
      },
    })
    expect(runCount).toBe(0)
  })

  test('names a missing package manager instead of starting a shell', async () => {
    expect(
      installCodeIntelTool(typescript, {
        resolveBinary: () => null,
        resolveTool: () => null,
      }),
    ).rejects.toThrow('npm is required')
  })

  test('fails when a successful installer leaves no discoverable tool', async () => {
    expect(
      installCodeIntelTool(typescript, {
        resolveBinary: () => '/host/bin/npm',
        resolveTool: () => null,
        run: async () => {},
      }),
    ).rejects.toThrow('cannot find it on the host PATH')
  })
})
