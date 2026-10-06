// Adapted from T3 Code packages/shared/src/composerInlineTokens.ts and packages/shared/src/video.ts (MIT, see ../UPSTREAM.md).
// Only the file mentions and video detection the markdown renderer reads.

export interface FileMentionToken {
  readonly value: string;
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

const MENTION_TOKEN_REGEX = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)/g;
// Autocomplete emits canonical file links, so ambiguous bare @scope/package text stays a package.
const SCOPED_PACKAGE_REFERENCE_REGEX =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[^\s@"]+)*$/;

/** `@path` and `@"quoted path"` mentions, in text order. */
export function collectFileMentionTokens(text: string): ReadonlyArray<FileMentionToken> {
  const matches: FileMentionToken[] = [];

  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const quotedPath = match[2];
    const path = quotedPath !== undefined ? quotedPath.replace(/\\(.)/g, "$1") : (match[3] ?? "");
    if (!path || (quotedPath === undefined && SCOPED_PACKAGE_REFERENCE_REGEX.test(path))) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    matches.push({ value: path, source: text.slice(start, end), start, end });
  }

  return matches;
}

const VIDEO_FILE_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm"]);

/** A file name the markdown renderer draws with the video icon. */
export function isVideoFileName(name: string): boolean {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 && VIDEO_FILE_EXTENSIONS.has(name.slice(dotIndex + 1).toLowerCase());
}
