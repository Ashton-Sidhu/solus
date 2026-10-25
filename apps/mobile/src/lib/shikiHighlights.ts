// Adapted from T3 Code apps/mobile/src/features/review/shikiReviewHighlighter.ts (MIT, see UPSTREAM.md).
// The highlighter for a binary without the native lexers (Expo Go, or a build
// made before modules/solus-highlights). `./highlights.ts` loads this module
// only there. Shiki's JavaScript engine with the GitHub themes the native
// tables use, in batches that yield to touches and rendering.
import { createHighlighterCore, type GrammarState, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import githubDarkDefault from "@shikijs/themes/github-dark-default";
import githubLightDefault from "@shikijs/themes/github-light-default";

import type { ReviewHighlightedToken } from "../features/review/reviewHighlightedToken.types";
import type { HighlightedLines, HighlightScheme } from "./highlights";

const SHIKI_THEME_BY_SCHEME = {
  light: "github-light-default",
  dark: "github-dark-default",
} as const;
// Bounds each tokenizing call by characters, not lines, so a file of long
// lines still yields to touches and renders between short batches.
const CHUNK_CHARACTERS = 2_000;
// A yield waits a timer turn, so batches run back to back until about one
// frame of work has passed instead of yielding after every batch.
const YIELD_AFTER_MS = 16;
const MAX_TOKENIZED_LINE_LENGTH = 1_000;

type LanguageModule = { default: Parameters<HighlighterCore["loadLanguage"]>[0] };

// The grammars the app shipped before the native lexers. Each is a separate
// lazy module, so the bundle loads only the ones a file needs.
const LANGUAGE_IMPORTS = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  jsx: () => import("@shikijs/langs/jsx"),
  tsx: () => import("@shikijs/langs/tsx"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  php: () => import("@shikijs/langs/php"),
  ruby: () => import("@shikijs/langs/ruby"),
  lua: () => import("@shikijs/langs/lua"),
  perl: () => import("@shikijs/langs/perl"),
  r: () => import("@shikijs/langs/r"),
  dart: () => import("@shikijs/langs/dart"),
  scala: () => import("@shikijs/langs/scala"),
  elixir: () => import("@shikijs/langs/elixir"),
  haskell: () => import("@shikijs/langs/haskell"),
  clojure: () => import("@shikijs/langs/clojure"),
  ocaml: () => import("@shikijs/langs/ocaml"),
  fsharp: () => import("@shikijs/langs/fsharp"),
  erlang: () => import("@shikijs/langs/erlang"),
  zig: () => import("@shikijs/langs/zig"),
  nim: () => import("@shikijs/langs/nim"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  less: () => import("@shikijs/langs/less"),
  xml: () => import("@shikijs/langs/xml"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  astro: () => import("@shikijs/langs/astro"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  bash: () => import("@shikijs/langs/bash"),
  powershell: () => import("@shikijs/langs/powershell"),
  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  docker: () => import("@shikijs/langs/docker"),
  hcl: () => import("@shikijs/langs/hcl"),
  nix: () => import("@shikijs/langs/nix"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  tex: () => import("@shikijs/langs/tex"),
  diff: () => import("@shikijs/langs/diff"),
  makefile: () => import("@shikijs/langs/makefile"),
  cmake: () => import("@shikijs/langs/cmake"),
  groovy: () => import("@shikijs/langs/groovy"),
} satisfies Record<string, () => Promise<LanguageModule>>;

type ShikiLanguage = keyof typeof LANGUAGE_IMPORTS;

// @pierre/highlights names and aliases that differ from the grammar names above.
const LANGUAGE_ALIASES = {
  cjs: "javascript",
  js: "javascript",
  mjs: "javascript",
  cts: "typescript",
  mts: "typescript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  golang: "go",
  kt: "kotlin",
  kts: "kotlin",
  m: "objective-c",
  mm: "objective-c",
  objc: "objective-c",
  objectivec: "objective-c",
  h: "c",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  "c#": "csharp",
  cs: "csharp",
  pl: "perl",
  pm: "perl",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  clj: "clojure",
  ml: "ocaml",
  fs: "fsharp",
  htm: "html",
  svg: "xml",
  yml: "yaml",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  ps1: "powershell",
  pwsh: "powershell",
  gql: "graphql",
  dockerfile: "docker",
  tf: "hcl",
  terraform: "hcl",
  md: "markdown",
  latex: "tex",
  patch: "diff",
  make: "makefile",
  mk: "makefile",
  gradle: "groovy",
} satisfies Record<string, ShikiLanguage>;

function hasEntry<Table extends object>(table: Table, key: string): key is Extract<keyof Table, string> {
  return Object.hasOwn(table, key);
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
const languageLoads = new Map<ShikiLanguage, Promise<boolean>>();

function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise) return highlighterPromise;
  const created = createHighlighterCore({
    themes: [githubLightDefault, githubDarkDefault],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  // A failed start is tried again on the next call.
  created.catch(() => {
    if (highlighterPromise === created) highlighterPromise = null;
  });
  highlighterPromise = created;
  return created;
}

function loadLanguage(highlighter: HighlighterCore, language: ShikiLanguage): Promise<boolean> {
  let load = languageLoads.get(language);
  if (!load) {
    load = LANGUAGE_IMPORTS[language]()
      .then((module) => highlighter.loadLanguage(module.default))
      .then(
        () => true,
        () => {
          languageLoads.delete(language);
          return false;
        },
      );
    languageLoads.set(language, load);
  }
  return load;
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function plainLine(content: string): ReadonlyArray<ReviewHighlightedToken> {
  return [{ content, color: null, fontStyle: null }];
}

/** Shiki's tokens for `code`, one array per line; plain lines for a grammar it lacks. */
export async function highlightWithShiki(
  code: string,
  language: string,
  scheme: HighlightScheme,
  signal?: AbortSignal,
): Promise<HighlightedLines> {
  const sourceLines = code.split(/\r?\n/u);
  const plainLines = () => sourceLines.map((line) => (line ? plainLine(line) : []));
  const grammar = hasEntry(LANGUAGE_ALIASES, language) ? LANGUAGE_ALIASES[language] : language;
  if (!hasEntry(LANGUAGE_IMPORTS, grammar)) return plainLines();
  const highlighter = await getHighlighter();
  if (!(await loadLanguage(highlighter, grammar))) return plainLines();

  const theme = SHIKI_THEME_BY_SCHEME[scheme];
  const highlightedLines: Array<ReadonlyArray<ReviewHighlightedToken>> = [];
  // Each batch resumes from the previous batch's grammar state, so a comment
  // or template string that spans a batch boundary keeps its colors.
  let grammarState: GrammarState | undefined;
  let start = 0;
  let sliceStartedAt = performance.now();

  while (start < sourceLines.length) {
    if (signal?.aborted) return [];
    if (sourceLines[start].length > MAX_TOKENIZED_LINE_LENGTH) {
      highlightedLines.push(plainLine(sourceLines[start]));
      // A skipped line's ending state is unknown; the next batch starts fresh.
      grammarState = undefined;
      start += 1;
    } else {
      let end = start;
      let characters = 0;
      while (end < sourceLines.length) {
        const length = sourceLines[end].length;
        if (
          length > MAX_TOKENIZED_LINE_LENGTH ||
          (end > start && characters + length + 1 > CHUNK_CHARACTERS)
        ) {
          break;
        }
        characters += length + (end > start ? 1 : 0);
        end += 1;
      }
      const tokenLines = highlighter.codeToTokensBase(sourceLines.slice(start, end).join("\n"), {
        lang: grammar,
        theme,
        grammarState,
      });
      grammarState = highlighter.getLastGrammarState(tokenLines);
      for (const line of tokenLines) {
        highlightedLines.push(
          line.map((token) => ({
            content: token.content,
            color: token.color ?? null,
            fontStyle: token.fontStyle ?? null,
          })),
        );
      }
      start = end;
    }

    if (start < sourceLines.length && performance.now() - sliceStartedAt >= YIELD_AFTER_MS) {
      await waitForNextFrame();
      sliceStartedAt = performance.now();
    }
  }

  return signal?.aborted ? [] : highlightedLines;
}
