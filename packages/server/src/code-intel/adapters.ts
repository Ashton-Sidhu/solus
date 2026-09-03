import { existsSync } from 'fs'
import { basename, extname, join } from 'path'
import { homedir } from 'os'
import type { CodeIntelLanguage } from '@solus/contracts/code-intel'
import { findOnPath, getCliPath } from '../cli-env'

/**
 * One adapter per language: how to recognise the language in a root, which
 * tool writes its SCIP index, and how to invoke it. Everything above this
 * layer is language-agnostic. Adding a language is adding an entry here.
 */
export interface CodeIntelAdapter {
  language: CodeIntelLanguage
  label: string
  /** Binary name on PATH. */
  toolName: string
  installCommand: string
  /** Fixed installer invocation. It is never built from client text. */
  installerName: string
  installerArgs: string[]
  /** Any of these at the root marks the language as present. */
  markerFiles: string[]
  extensions: string[]
  indexArgs(root: string, outputPath: string): string[]
}

export const CODE_INTEL_ADAPTERS: readonly CodeIntelAdapter[] = [
  {
    language: 'typescript',
    label: 'TypeScript',
    toolName: 'scip-typescript',
    installCommand: 'npm install -g @sourcegraph/scip-typescript',
    installerName: 'npm',
    installerArgs: ['install', '-g', '@sourcegraph/scip-typescript'],
    markerFiles: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    indexArgs(root, outputPath) {
      const args = ['index', '--output', outputPath]
      // A plain package.json project has no tsconfig to read; let the indexer
      // synthesise one rather than fail on a JavaScript repository.
      if (!existsSync(join(root, 'tsconfig.json')) && !existsSync(join(root, 'jsconfig.json'))) {
        args.push('--infer-tsconfig')
      }
      return args
    },
  },
  {
    language: 'python',
    label: 'Python',
    toolName: 'scip-python',
    installCommand: 'npm install -g @sourcegraph/scip-python',
    installerName: 'npm',
    installerArgs: ['install', '-g', '@sourcegraph/scip-python'],
    markerFiles: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'],
    extensions: ['.py', '.pyi'],
    indexArgs(root, outputPath) {
      return ['index', '.', '--output', outputPath, '--project-name', basename(root), '--quiet']
    },
  },
  {
    language: 'go',
    label: 'Go',
    toolName: 'scip-go',
    installCommand: 'go install github.com/sourcegraph/scip-go/cmd/scip-go@latest',
    installerName: 'go',
    installerArgs: ['install', 'github.com/sourcegraph/scip-go/cmd/scip-go@latest'],
    markerFiles: ['go.mod'],
    extensions: ['.go'],
    indexArgs(_root, outputPath) {
      return ['--output', outputPath, '--quiet']
    },
  },
  {
    language: 'rust',
    label: 'Rust',
    toolName: 'rust-analyzer',
    installCommand: 'rustup component add rust-analyzer',
    installerName: 'rustup',
    installerArgs: ['component', 'add', 'rust-analyzer'],
    markerFiles: ['Cargo.toml'],
    extensions: ['.rs'],
    indexArgs(_root, outputPath) {
      return ['scip', '.', '--output', outputPath]
    },
  },
]

export function languageForPath(path: string): CodeIntelLanguage | null {
  const extension = extname(path).toLowerCase()
  if (!extension) return null
  for (const adapter of CODE_INTEL_ADAPTERS) {
    if (adapter.extensions.includes(extension)) return adapter.language
  }
  return null
}

export function detectLanguage(adapter: CodeIntelAdapter, root: string): boolean {
  return adapter.markerFiles.some((marker) => existsSync(join(root, marker)))
}

/** The tool on the login-shell PATH, or a project-local install for the npm
 *  distributed indexers, which teams often pin in devDependencies. */
export function resolveToolBinary(adapter: CodeIntelAdapter, root: string | null): string | null {
  const onPath = findOnPath(adapter.toolName, getCliPath())
  if (onPath) return onPath
  if (adapter.language === 'go') {
    const goInstallDefault = join(homedir(), 'go', 'bin', adapter.toolName)
    if (existsSync(goInstallDefault)) return goInstallDefault
  }
  if (!root) return null
  const local = join(root, 'node_modules', '.bin', adapter.toolName)
  return existsSync(local) ? local : null
}
