// Adapted from T3 Code apps/mobile/src/features/files/sourceHighlightingState.ts (MIT, see UPSTREAM.md).
// T3 keeps results in an Effect atom family with an idle TTL; this is the same
// contract as a small cache and a React hook. The native lexers settle a
// highlight in the call, so the first render of a file is colored; only the
// Shiki fallback for a binary without them is awaited.
import { useEffect, useState } from "react";

import { resolveHighlightLanguage } from "../../lib/highlightLanguage";
import { highlightCode, type HighlightedLines, type HighlightScheme } from "../../lib/highlights";

const SOURCE_HIGHLIGHT_IDLE_TTL_MS = 5 * 60_000;
const SOURCE_HIGHLIGHT_CACHE_LIMIT = 8;

export interface SourceHighlightInput {
  readonly path: string;
  readonly contents: string;
  readonly theme: HighlightScheme;
}

type SourceHighlighter = (
  input: SourceHighlightInput,
) => HighlightedLines | Promise<HighlightedLines>;

export type SourceHighlightResult =
  | { readonly status: "highlighting"; readonly tokens: null }
  | { readonly status: "ready"; readonly tokens: HighlightedLines }
  | { readonly status: "error"; readonly tokens: null };

interface CachedHighlight {
  readonly promise: Promise<SourceHighlightResult>;
  settled: SourceHighlightResult | null;
  lastUsedAt: number;
}

const HIGHLIGHTING: SourceHighlightResult = { status: "highlighting", tokens: null };
const HIGHLIGHT_FAILED: SourceHighlightResult = { status: "error", tokens: null };

function highlightSourceFile(input: SourceHighlightInput): HighlightedLines | Promise<HighlightedLines> {
  return highlightCode(input.contents, resolveHighlightLanguage({ path: input.path }), input.theme);
}

function startHighlight(
  highlight: SourceHighlighter,
  input: SourceHighlightInput,
  lastUsedAt: number,
): CachedHighlight {
  let tokens: HighlightedLines | Promise<HighlightedLines>;
  try {
    tokens = highlight(input);
  } catch {
    return { promise: Promise.resolve(HIGHLIGHT_FAILED), settled: HIGHLIGHT_FAILED, lastUsedAt };
  }
  if (!(tokens instanceof Promise)) {
    const settled: SourceHighlightResult = { status: "ready", tokens };
    return { promise: Promise.resolve(settled), settled, lastUsedAt };
  }
  const entry: CachedHighlight = {
    promise: tokens.then(
      (lines): SourceHighlightResult => {
        entry.settled = { status: "ready", tokens: lines };
        return entry.settled;
      },
      (): SourceHighlightResult => {
        entry.settled = HIGHLIGHT_FAILED;
        return HIGHLIGHT_FAILED;
      },
    ),
    settled: null,
    lastUsedAt,
  };
  return entry;
}

/**
 * One highlight per (theme, path, contents). A remount of the same file reads
 * the finished result in its first render; changed contents highlight again.
 * An entry nobody read for `idleTtlMs` is highlighted again on its next read.
 */
export function createSourceHighlightCache(options?: {
  readonly highlight?: SourceHighlighter;
  readonly idleTtlMs?: number;
  readonly now?: () => number;
}) {
  const highlight = options?.highlight ?? highlightSourceFile;
  const idleTtlMs = options?.idleTtlMs ?? SOURCE_HIGHLIGHT_IDLE_TTL_MS;
  const now = options?.now ?? Date.now;
  const entries = new Map<string, CachedHighlight>();

  const keyOf = (input: SourceHighlightInput) =>
    `${input.theme}\u0000${input.path}\u0000${input.contents}`;

  function entryFor(input: SourceHighlightInput): CachedHighlight {
    const key = keyOf(input);
    const time = now();
    const existing = entries.get(key);
    if (existing && time - existing.lastUsedAt <= idleTtlMs) {
      existing.lastUsedAt = time;
      entries.delete(key);
      entries.set(key, existing);
      return existing;
    }
    const entry = startHighlight(highlight, input, time);
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > SOURCE_HIGHLIGHT_CACHE_LIMIT) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
    return entry;
  }

  return {
    /** The settled result, or null while the highlight runs. */
    peek(input: SourceHighlightInput): SourceHighlightResult | null {
      return entryFor(input).settled;
    },
    load(input: SourceHighlightInput): Promise<SourceHighlightResult> {
      return entryFor(input).promise;
    },
  };
}

const sourceHighlightCache = createSourceHighlightCache();

export function useSourceHighlight(input: SourceHighlightInput): SourceHighlightResult {
  const { path, contents, theme } = input;
  const key = `${theme}\u0000${path}\u0000${contents}`;
  const settled = sourceHighlightCache.peek({ path, contents, theme });
  const isSettled = settled !== null;
  const [loaded, setLoaded] = useState<{ key: string; result: SourceHighlightResult } | null>(
    null,
  );

  useEffect(() => {
    if (isSettled) return;
    let active = true;
    void sourceHighlightCache.load({ path, contents, theme }).then((result) => {
      if (active) setLoaded({ key, result });
    });
    return () => {
      active = false;
    };
  }, [contents, isSettled, key, path, theme]);

  if (settled) return settled;
  return loaded?.key === key ? loaded.result : HIGHLIGHTING;
}
