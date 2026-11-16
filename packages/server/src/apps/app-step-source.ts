/**
 * Where a step of a workflow is in an app's source (docs/plans/apps.md §9.2).
 * The host does not record it at build time, so the Workflows section's Code
 * button reads the revision of a version and finds the step's
 * `step.do('<name>'` call. The read is bounded: only text source files, and
 * only so many of them and so many bytes. Pure apart from `readFile`, so the
 * search is tested with fixture sources.
 */

/** The extensions of the source files the search reads. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts']
/** Folders that hold no source the app's author wrote. */
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'build', '.solus', '.git'])
/** The most files and bytes the search reads. A file larger than `MAX_FILE_BYTES` is not read. */
export const MAX_SOURCE_FILES = 200
export const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024

export interface StepSourceFile {
  path: string
  text: string
}

export interface StepPlace {
  path: string
  /** From 1. */
  line: number
  /** From 1: the first character of the receiver of `.do(`. */
  column: number
}

/** The paths the search reads, in a stable order: source files only, outside the build and package folders. */
export function stepSourcePaths(paths: readonly string[]): string[] {
  return paths
    .filter((path) => SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) && !path.endsWith('.d.ts'))
    .filter((path) => !path.split('/').some((part) => SKIPPED_FOLDERS.has(part)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_SOURCE_FILES)
}

/** Reads the source files of `paths` with the byte limits. A file that is too large or not there is not read. */
export async function readStepSourceFiles(paths: readonly string[], readFile: (path: string) => Promise<Buffer | null>): Promise<StepSourceFile[]> {
  const files: StepSourceFile[] = []
  let total = 0
  for (const path of stepSourcePaths(paths)) {
    const bytes = await readFile(path)
    if (!bytes || bytes.length > MAX_FILE_BYTES) continue
    if (total + bytes.length > MAX_TOTAL_BYTES) break
    total += bytes.length
    files.push({ path, text: bytes.toString('utf8') })
  }
  return files
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every `<receiver>.do(<quote><step><quote>` call: the name must be the whole string, so `fetch` does not match `fetch-notes`. */
function stepCalls(text: string, step: string): number[] {
  const pattern = new RegExp(`(?<![\\w$])[A-Za-z_$][\\w$]*\\s*\\.\\s*do\\s*\\(\\s*(['"\`])${escapeRegExp(step)}\\1`, 'g')
  return [...text.matchAll(pattern)].map((match) => match.index)
}

/** Where the workflow is declared in a file: `<name>: workflow(`, with the key in quotes or not. */
function workflowDeclaration(text: string, workflow: string): number | null {
  const name = escapeRegExp(workflow)
  const match = new RegExp(`(?<![\\w$])(?:${name}|(['"\`])${name}\\1)\\s*:\\s*workflow\\s*\\(`).exec(text)
  return match ? match.index : null
}

/** Where the next workflow after the one at `after` is declared; the end of the text when none is. */
function nextWorkflowDeclaration(text: string, after: number): number {
  const pattern = /:\s*workflow\s*\(/g
  pattern.lastIndex = text.indexOf('(', after) + 1
  return pattern.exec(text)?.index ?? text.length
}

function placeOf(file: StepSourceFile, index: number): StepPlace {
  const before = file.text.slice(0, index)
  const lineStart = before.lastIndexOf('\n') + 1
  return { path: file.path, line: before.split('\n').length, column: index - lineStart + 1 }
}

/**
 * The place of the step's call. Two workflows can each have a step of the
 * same name, so the first call between the workflow's own declaration and
 * the next workflow's wins.
 * When no file declares the workflow in a form the search knows (a workflow
 * from a helper, for example), the first call in path order wins.
 */
export function findStepPlace(files: readonly StepSourceFile[], workflow: string, step: string): StepPlace | null {
  for (const file of files) {
    const declared = workflowDeclaration(file.text, workflow)
    if (declared === null) continue
    const next = nextWorkflowDeclaration(file.text, declared)
    const call = stepCalls(file.text, step).find((index) => index > declared && index < next)
    if (call !== undefined) return placeOf(file, call)
  }
  for (const file of files) {
    const [call] = stepCalls(file.text, step)
    if (call !== undefined) return placeOf(file, call)
  }
  return null
}
