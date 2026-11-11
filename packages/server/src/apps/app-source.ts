import { createHash } from 'node:crypto'
import { transform } from 'sucrase'

/**
 * An app's source (docs/plans/apps.md §3 and §4): the roles it names and the
 * script the shell runs. Pure: no store, no gateway, so it is tested as text.
 */

/** Blanks line and block comments, keeping length and newlines, so a commented-out
 *  `tools.github.…` does not become a role. String literals are left alone. */
function withCommentsBlanked(code: string): string {
  return code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, ' '))
}

const TOOLS_REFERENCE = /(?<![.\w$])tools\s*(?:\.\s*([A-Za-z_$][\w$-]*)|\[\s*(?:"([A-Za-z_$][\w$-]*)"|'([A-Za-z_$][\w$-]*)')\s*\])/g

/** The integration slugs the source reaches through `tools.<slug>`, first use first, repeats collapsed. */
export function extractAppRoles(code: string): string[] {
  const found: string[] = []
  for (const match of withCommentsBlanked(code).matchAll(TOOLS_REFERENCE)) {
    const slug = match[1] ?? match[2] ?? match[3]
    if (slug && !found.includes(slug)) found.push(slug)
  }
  return found
}

export class AppCompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppCompileError'
  }
}

const compiled = new Map<string, string>()
const COMPILED_CACHE_LIMIT = 64

/**
 * The component as the shell runs it: types stripped, JSX turned into
 * `react/jsx-runtime` calls, imports turned into `require` calls the shell
 * answers. Memoized by the source hash; a syntax error is an `AppCompileError`
 * whose message names the line.
 */
export function compileAppComponent(code: string): string {
  const hash = createHash('sha256').update(code).digest('hex')
  const cached = compiled.get(hash)
  if (cached !== undefined) return cached
  let output: string
  try {
    output = transform(code, {
      transforms: ['typescript', 'jsx', 'imports'],
      jsxRuntime: 'automatic',
      production: true,
      disableESTransforms: true,
      filePath: 'app.tsx',
    }).code
  } catch (error) {
    throw new AppCompileError(error instanceof Error ? error.message : String(error))
  }
  const oldest = compiled.keys().next()
  if (compiled.size >= COMPILED_CACHE_LIMIT && !oldest.done) compiled.delete(oldest.value)
  compiled.set(hash, output)
  return output
}

/** Why a body cannot be an app's source, or null when it can. Every write of an `app` work passes here. */
export function appSourceProblem(code: string): string | null {
  if (!code.trim()) return 'An app needs a component: the source is empty.'
  if (!/export\s+default\b/.test(withCommentsBlanked(code))) return 'An app must `export default` a React component.'
  try {
    compileAppComponent(code)
    return null
  } catch (error) {
    return `The app source does not compile: ${error instanceof Error ? error.message : String(error)}`
  }
}
