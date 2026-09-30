/**
 * Every directory that some file in `files` already puts on screen.
 *
 * The indexed project listing names files only, so a client drawing a tree
 * infers folders from the paths. That leaves the folders holding no indexed
 * file invisible, and this set is what tells the two cases apart.
 */
export function directoriesHoldingFiles(files: readonly string[]): Set<string> {
  const holders = new Set<string>()
  for (const file of files) {
    let slash = file.lastIndexOf('/')
    while (slash > 0) {
      const directory = file.slice(0, slash)
      if (holders.has(directory)) break
      holders.add(directory)
      slash = directory.lastIndexOf('/')
    }
  }
  return holders
}
