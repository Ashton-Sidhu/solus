/*
 * A code span that names a file renders as a chip. The chip has room for the
 * last two segments only, so the parts it drops are rendered copy-only: a
 * selection copied out of a message then carries the whole path the author
 * wrote, not the two segments that happened to fit.
 */

export function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** The one directory the chip shows, with its slash. Empty for a bare name. */
export function parentDir(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  return `${parts[parts.length - 2]}/`;
}

/** Everything ahead of what the chip shows. Empty when the chip shows it all. */
export function leadingDirs(path: string): string {
  return path.slice(0, path.length - (parentDir(path) + basename(path)).length);
}
