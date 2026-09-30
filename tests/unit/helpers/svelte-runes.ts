import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileModule } from 'svelte/compiler'

const root = new URL('../../../', import.meta.url)
const client = new URL('node_modules/svelte/src/index-client.js', root).href
const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
const transpiler = new Bun.Transpiler({ loader: 'ts' })

/**
 * Runs `.svelte.ts` modules on Svelte's real client runtime, so a test sees
 * the same deriveds, proxies, and invalidation the app does. Each module is
 * compiled into a temporary directory; `rewrite` points its relative imports
 * at other compiled modules or at source files by absolute URL.
 */
export class SvelteRunes {
  readonly directory = mkdtempSync(join(tmpdir(), 'solus-runes-'))

  /** Compile rune source (TypeScript allowed) and return an importable path. */
  module(name: string, source: string, rewrite: Record<string, string> = {}): string {
    let code = transpiler.transformSync(source)
    for (const [from, to] of Object.entries(rewrite)) code = code.replaceAll(JSON.stringify(from), JSON.stringify(to)).replaceAll(`'${from}'`, JSON.stringify(to))
    const js = compileModule(code, { filename: `${name}.svelte.js`, generate: 'client' }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    const path = join(this.directory, `${name}.mjs`)
    writeFileSync(path, js)
    return path
  }

  /** Compile a workspace source file by its repository path. */
  source(name: string, repoPath: string, rewrite: Record<string, string> = {}): string {
    return this.module(name, readFileSync(new URL(repoPath, root), 'utf8'), rewrite)
  }

  /** A repository file as an import specifier, for `rewrite`. */
  static file(repoPath: string): string {
    return new URL(repoPath, root).href
  }

  static runtime(): string {
    return client
  }

  dispose(): void {
    rmSync(this.directory, { recursive: true, force: true })
  }
}
