/** A file a link or a mention names, and the line it points at. */
export interface FileHrefTarget {
  path: string;
  line?: number;
}

const LINE_SUFFIX_RE = /^(.+?):(\d+)(?::\d+)?$/;

/** `src/foo.ts:12` (or `:12:4`) as the path and the line; a bare path as is. */
export function splitFileLine(path: string): FileHrefTarget {
  const match = path.match(LINE_SUFFIX_RE);
  return match ? { path: match[1], line: Number(match[2]) } : { path };
}
