// A changed file's path, split the way every diff header draws it: the folder
// muted, the name emphasized, and the extension as a badge when no brand icon
// knows the language.

export function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

/** The folder with its trailing slash; empty for a file at the root. */
export function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i + 1) : ''
}

/** The upper-case extension, or a dot for a file with none. */
export function extensionLabel(path: string): string {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : '·'
}
