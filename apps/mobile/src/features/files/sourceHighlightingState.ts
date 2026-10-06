// Adapted from T3 Code apps/mobile/src/features/files/sourceHighlightingState.ts (MIT, see UPSTREAM.md).
// T3 keeps results in an Effect atom family with an idle TTL; this is the same
// contract as a small promise cache and a React hook.
import { useEffect, useState } from "react";

import {
  highlightSourceFile,
  type ReviewDiffTheme,
  type ReviewHighlightedToken,
} from "../review/shikiReviewHighlighter";

const SOURCE_HIGHLIGHT_IDLE_TTL_MS = 5 * 60_000;
const SOURCE_HIGHLIGHT_CACHE_LIMIT = 8;

export interface SourceHighlightInput {
  readonly path: string;
  readonly contents: string;
  readonly theme: ReviewDiffTheme;
}

export type SourceHighlightTokens = ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;

type SourceHighlighter = (input: SourceHighlightInput) => Promise<SourceHighlightTokens>;

export type SourceHighlightResult =
  | { readonly status: "highlighting"; readonly tokens: null }
  | { readonly status: "ready"; readonly tokens: SourceHighlightTokens }
  | { readonly status: "error"; readonly tokens: null };

interface CachedHighlight {
  readonly promise: Promise<SourceHighlightTokens>;
  settled: SourceHighlightResult | null;
  lastUsedAt: number;
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
    const entry: CachedHighlight = {
      promise: highlight(input),
      settled: null,
      lastUsedAt: time,
    };
    entry.promise.then(
      (tokens) => {
        entry.settled = { status: "ready", tokens };
      },
      () => {
        entry.settled = { status: "error", tokens: null };
      },
    );
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
      return entryFor(input).promise.then(
        (tokens): SourceHighlightResult => ({ status: "ready", tokens }),
        (): SourceHighlightResult => ({ status: "error", tokens: null }),
      );
    },
  };
}

const sourceHighlightCache = createSourceHighlightCache();
const HIGHLIGHTING: SourceHighlightResult = { status: "highlighting", tokens: null };

export function useSourceHighlight(input: SourceHighlightInput): SourceHighlightResult {
  const { path, contents, theme } = input;
  const key = `${theme}\u0000${path}\u0000${contents}`;
  const [loaded, setLoaded] = useState<{ key: string; result: SourceHighlightResult } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    void sourceHighlightCache.load({ path, contents, theme }).then((result) => {
      if (active) setLoaded({ key, result });
    });
    return () => {
      active = false;
    };
  }, [contents, key, path, theme]);

  if (loaded?.key === key) return loaded.result;
  return sourceHighlightCache.peek({ path, contents, theme }) ?? HIGHLIGHTING;
}
