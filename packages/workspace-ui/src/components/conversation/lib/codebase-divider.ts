/**
 * The words after the name of the codebase in the divider of a codebase that
 * the host made (docs/plans/codebases.md decision 13): the folders it was made
 * from, as the host recorded their names. The host makes a codebase from two
 * folders, the project folder and a second project that was attached. A
 * divider has no end period. With fewer than two names, the line names only
 * the codebase.
 */
export function codebaseDividerFolders(folderNames: readonly string[]): string {
  if (folderNames.length < 2) return ''
  return `from the folders ${folderNames.slice(0, -1).join(', ')} and ${folderNames.at(-1)}`
}
