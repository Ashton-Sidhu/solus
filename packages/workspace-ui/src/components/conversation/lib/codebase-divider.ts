/**
 * The words after the name of the codebase in the divider of a codebase that
 * the host made (docs/plans/codebases.md decision 13): the folders it was made
 * from, as the host recorded their names. A divider has no end period. With no
 * folder name, the line names only the codebase.
 */
export function codebaseDividerFolders(folderNames: readonly string[]): string {
  if (folderNames.length === 0) return ''
  if (folderNames.length === 1) return `from the folder ${folderNames[0]}`
  return `from the folders ${folderNames.slice(0, -1).join(', ')} and ${folderNames.at(-1)}`
}
