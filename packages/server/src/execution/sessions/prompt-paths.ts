import { stat } from 'node:fs/promises'
import { resolveHomePath } from '../../platform/paths'

/**
 * The paths that the text of a prompt names (docs/plans/codebases.md §6): a
 * path that starts with `/` or `~/`. `pathsNamedInPrompt` gives only the
 * candidates. `attachablePromptPaths` reads the disk and keeps the ones that
 * the prompt trigger of the attach rule can use.
 */

/** One prompt attaches the folders of at most this many paths: a prompt names the folders of the work, and they are few. */
export const PROMPT_PATH_LIMIT = 3

/** One prompt is read for at most this many candidates: a pasted log can name hundreds of paths. */
const PROMPT_PATH_SCAN_LIMIT = 64

export interface PromptPath {
  path: string
  /** The person pointed at the path with an `@` mention. */
  explicit: boolean
}

/**
 * What a client writes for a pasted or dropped file, which the person did not
 * type: `[Attached file: /a path/with spaces.txt]` (also `image` and
 * `design-selection`: each text in these brackets is from a client), and the
 * `Annotated capture: <path>` line of a browser annotation. The file is where the system or the host put it (a temporary
 * directory, the attachment store), so its path is not a request to work in
 * its folder.
 */
const ATTACHMENT = /\[Attached [^\]\n]*\]|^Annotated capture: .*$/gm
/** A path in quotes or backticks can contain spaces. An `@` before the first quote makes it a mention. */
const QUOTED = /(@?)(["'`])((?:~\/|\/)[^"'`\n]*)\2/g
/**
 * A path with no quotes: it starts the text or follows a space, a bracket, an
 * `@` (a mention), `=`, `:` or `,`. A `/` in the middle of a word (`src/a.ts`,
 * `https://host/a`) does not start a path.
 */
const BARE = /(^|[\s([<@=:,])((?:~\/|\/)[^\s"'`<>()[\]{}|*?]+)/g

/** Punctuation of the sentence that follows a path, not a part of the path. */
const TRAILING = /[.,;:!?]+$/

export function pathsNamedInPrompt(text: string, limit = PROMPT_PATH_SCAN_LIMIT): PromptPath[] {
  const found: { at: number; path: string; explicit: boolean }[] = []
  // A matched range becomes spaces, so the next pattern cannot read a part of it again.
  let rest = text.replace(ATTACHMENT, (match) => ' '.repeat(match.length))
  for (const match of rest.matchAll(QUOTED)) found.push({ at: match.index, path: match[3], explicit: match[1] === '@' })
  rest = rest.replace(QUOTED, (match) => ' '.repeat(match.length))
  for (const match of rest.matchAll(BARE)) found.push({ at: match.index, path: match[2], explicit: match[1] === '@' })

  const paths: PromptPath[] = []
  for (const { path, explicit } of found.sort((a, b) => a.at - b.at)) {
    const cleaned = path.trim().replace(TRAILING, '')
    // `//` starts a comment or the host of a URL, and `/` or `~/` alone names no folder of the work.
    if (cleaned === '/' || cleaned === '~/' || cleaned.startsWith('//')) continue
    const known = paths.find((each) => each.path === cleaned)
    if (known) {
      known.explicit ||= explicit
      continue
    }
    if (paths.length < limit) paths.push({ path: cleaned, explicit })
  }
  return paths
}

/**
 * The paths of a prompt whose folder the prompt trigger attaches, at most
 * `PROMPT_PATH_LIMIT` of them:
 *
 * - a path that names a directory on this host: the person named a folder
 *   ("make a change in ~/solus-cloud");
 * - a path that names a file, only when the person pointed at it with an `@`
 *   mention. A file path in the text is not a request to work in its folder:
 *   a pasted log names many files.
 *
 * The path of an attachment is not in the answer: a pasted or dropped file is
 * not a request to work in a folder.
 */
export async function attachablePromptPaths(text: string): Promise<string[]> {
  const paths: string[] = []
  for (const { path, explicit } of pathsNamedInPrompt(text)) {
    if (paths.length === PROMPT_PATH_LIMIT) break
    const entry = await stat(resolveHomePath(path)).catch(() => null)
    if (entry?.isDirectory() || (entry?.isFile() && explicit)) paths.push(path)
  }
  return paths
}
