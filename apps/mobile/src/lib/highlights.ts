// Adapted from T3 Code apps/mobile/src/lib/highlights.ts (MIT, see UPSTREAM.md).
// T3 shows plain text when the native module is missing; Solus colors the code
// with Shiki's JavaScript engine there instead (`./shikiHighlights.ts`).
import { requireOptionalNativeModule } from "expo";

import type { ReviewHighlightedToken } from "../features/review/reviewHighlightedToken.types";
import { highlightLanguageId } from "./highlightLanguage";
import { HIGHLIGHTS_THEME_STYLES } from "./highlights.generated";

export type HighlightScheme = "light" | "dark";

export type HighlightedLines = ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;

interface SolusHighlightsModule {
  tokenize(source: string, language: number): ArrayBuffer | null;
}

const LINE_END = 0xffffffff;
// Longer lines stay one plain token so a minified line does not become
// thousands of native text runs. The lexer still reads them, so the lines
// after them keep their colors.
const MAX_HIGHLIGHTED_LINE_LENGTH = 1_000;

// @pierre/highlights compiled to native code (modules/solus-highlights).
// Optional, so Expo Go or a binary built before the module existed colors
// code with Shiki instead of crashing.
const nativeHighlights = requireOptionalNativeModule<SolusHighlightsModule>("SolusHighlights");

function plainLines(code: string): HighlightedLines {
  return code
    .split(/\r?\n/u)
    .map((line) => (line ? [{ content: line, color: null, fontStyle: null }] : []));
}

/**
 * The lines of `code` from the lexer's `(endUtf16, tokenId)` records. A
 * LINE_END token ID ends a line, and its end is where the next line starts.
 * Mirrors @pierre/highlights' `lineRecordsToTokens`.
 */
export function decodeHighlightRecords(
  code: string,
  records: Uint32Array,
  scheme: HighlightScheme,
): HighlightedLines {
  const styles = HIGHLIGHTS_THEME_STYLES[scheme];
  const lines: ReviewHighlightedToken[][] = [];
  let start = 0;
  for (let record = 0; ; record += 2) {
    const first = record;
    while (record < records.length && records[record + 1] !== LINE_END) record += 2;
    const end = record === first ? start : records[record - 2];
    if (end - start > MAX_HIGHLIGHTED_LINE_LENGTH) {
      lines.push([{ content: code.slice(start, end), color: null, fontStyle: null }]);
    } else {
      const line: ReviewHighlightedToken[] = [];
      for (let at = first; at < record; at += 2) {
        const tokenEnd = records[at];
        if (tokenEnd <= start) continue;
        const [color, fontStyle] = styles[records[at + 1]] ?? styles[0];
        line.push({ content: code.slice(start, tokenEnd), color, fontStyle });
        start = tokenEnd;
      }
      lines.push(line);
    }
    if (record >= records.length) break;
    start = records[record];
  }
  return lines;
}

/**
 * Tokenizes `code`, one token array per line. Lines split at LF and CRLF, and
 * a trailing line break yields a final empty line. The native lexers answer
 * in the call, so the first frame paints colored code. Without them, the
 * answer is a promise of Shiki's tokens; `signal` stops that work early.
 */
export function highlightCode(
  code: string,
  language: string,
  scheme: HighlightScheme,
  signal?: AbortSignal,
): HighlightedLines | Promise<HighlightedLines> {
  const id = highlightLanguageId(language);
  if (id === 0) return plainLines(code);
  if (!nativeHighlights) {
    return import("./shikiHighlights").then((shiki) =>
      shiki.highlightWithShiki(code, language, scheme, signal),
    );
  }
  const buffer = nativeHighlights.tokenize(code, id);
  return buffer ? decodeHighlightRecords(code, new Uint32Array(buffer), scheme) : plainLines(code);
}
