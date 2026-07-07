import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export interface SearchMatch {
  from: number;
  to: number;
}

export interface SearchState {
  searchTerm: string;
  replaceTerm: string;
  caseSensitive: boolean;
  results: SearchMatch[];
  currentIndex: number;
  deco: DecorationSet;
}

export const searchPluginKey = new PluginKey<SearchState>("documentSearch");

/** Read the live search state for the find bar (counter, current match). */
export function getSearchState(state: {
  plugins: unknown;
}): SearchState | undefined {
  // `state` is an EditorState; typed loosely so callers can pass editor.state.
  return searchPluginKey.getState(state as never);
}

function findMatches(
  doc: ProseMirrorNode,
  term: string,
  caseSensitive: boolean,
): SearchMatch[] {
  const results: SearchMatch[] = [];
  if (!term) return results;
  const needle = caseSensitive ? term : term.toLowerCase();

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const haystack = caseSensitive ? node.text : node.text.toLowerCase();
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      results.push({ from: pos + idx, to: pos + idx + term.length });
      idx = haystack.indexOf(needle, idx + needle.length);
    }
  });
  return results;
}

function buildDeco(
  doc: ProseMirrorNode,
  results: SearchMatch[],
  currentIndex: number,
): DecorationSet {
  if (results.length === 0) return DecorationSet.empty;
  const decos = results.map((r, i) =>
    Decoration.inline(r.from, r.to, {
      class:
        i === currentIndex
          ? "search-match search-match--current"
          : "search-match",
    }),
  );
  return DecorationSet.create(doc, decos);
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    documentSearch: {
      setSearchTerm: (term: string) => ReturnType;
      setReplaceTerm: (term: string) => ReturnType;
      setSearchCaseSensitive: (value: boolean) => ReturnType;
      findNextMatch: () => ReturnType;
      findPrevMatch: () => ReturnType;
      replaceCurrentMatch: () => ReturnType;
      replaceAllMatches: () => ReturnType;
      clearSearch: () => ReturnType;
    };
  }
}

const EMPTY: SearchState = {
  searchTerm: "",
  replaceTerm: "",
  caseSensitive: false,
  results: [],
  currentIndex: 0,
  deco: DecorationSet.empty,
};

export const SearchExtension = Extension.create({
  name: "documentSearch",

  addCommands() {
    const setMeta = (patch: Partial<SearchState>) =>
      ({ tr, dispatch }: { tr: import("@tiptap/pm/state").Transaction; dispatch?: (tr: import("@tiptap/pm/state").Transaction) => void }) => {
        if (dispatch) dispatch(tr.setMeta(searchPluginKey, patch));
        return true;
      };

    return {
      setSearchTerm:
        (term) =>
        ({ tr, dispatch }) => {
          if (dispatch)
            dispatch(
              tr.setMeta(searchPluginKey, { searchTerm: term, currentIndex: 0 }),
            );
          return true;
        },
      setReplaceTerm: (term) => setMeta({ replaceTerm: term }),
      setSearchCaseSensitive:
        (value) =>
        ({ tr, dispatch }) => {
          if (dispatch)
            dispatch(
              tr.setMeta(searchPluginKey, {
                caseSensitive: value,
                currentIndex: 0,
              }),
            );
          return true;
        },
      findNextMatch:
        () =>
        ({ state, tr, dispatch }) => {
          const s = searchPluginKey.getState(state);
          if (!s || s.results.length === 0) return false;
          const idx = (s.currentIndex + 1) % s.results.length;
          if (dispatch) {
            const match = s.results[idx];
            tr.setMeta(searchPluginKey, { currentIndex: idx });
            tr.setSelection(TextSelection.create(tr.doc, match.from, match.to));
            tr.scrollIntoView();
            dispatch(tr);
          }
          return true;
        },
      findPrevMatch:
        () =>
        ({ state, tr, dispatch }) => {
          const s = searchPluginKey.getState(state);
          if (!s || s.results.length === 0) return false;
          const idx =
            (s.currentIndex - 1 + s.results.length) % s.results.length;
          if (dispatch) {
            const match = s.results[idx];
            tr.setMeta(searchPluginKey, { currentIndex: idx });
            tr.setSelection(TextSelection.create(tr.doc, match.from, match.to));
            tr.scrollIntoView();
            dispatch(tr);
          }
          return true;
        },
      replaceCurrentMatch:
        () =>
        ({ state, tr, dispatch }) => {
          const s = searchPluginKey.getState(state);
          if (!s || s.results.length === 0) return false;
          const match = s.results[s.currentIndex];
          if (dispatch) {
            tr.insertText(s.replaceTerm, match.from, match.to);
            tr.scrollIntoView();
            dispatch(tr);
          }
          return true;
        },
      replaceAllMatches:
        () =>
        ({ state, tr, dispatch }) => {
          const s = searchPluginKey.getState(state);
          if (!s || s.results.length === 0) return false;
          if (dispatch) {
            // Replace last-to-first so earlier match positions stay valid.
            for (let i = s.results.length - 1; i >= 0; i--) {
              const m = s.results[i];
              tr.insertText(s.replaceTerm, m.from, m.to);
            }
            dispatch(tr);
          }
          return true;
        },
      clearSearch:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch)
            dispatch(
              tr.setMeta(searchPluginKey, { searchTerm: "", currentIndex: 0 }),
            );
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchPluginKey,
        state: {
          init: () => EMPTY,
          apply(tr, value, _oldState, newState) {
            const meta = tr.getMeta(searchPluginKey) as
              | Partial<SearchState>
              | undefined;

            // Selection-only transactions — and edits with no active search —
            // can't change the match set. Reuse the previous state instead of
            // rescanning the doc and rebuilding the DecorationSet on every
            // keystroke/click.
            if (!meta && (!tr.docChanged || !value.searchTerm)) return value;

            let searchTerm = value.searchTerm;
            let replaceTerm = value.replaceTerm;
            let caseSensitive = value.caseSensitive;
            let results = value.results;
            let currentIndex = value.currentIndex;

            if (meta) {
              if (meta.searchTerm !== undefined) searchTerm = meta.searchTerm;
              if (meta.replaceTerm !== undefined) replaceTerm = meta.replaceTerm;
              if (meta.caseSensitive !== undefined)
                caseSensitive = meta.caseSensitive;
              if (meta.currentIndex !== undefined)
                currentIndex = meta.currentIndex;
            }

            const paramsChanged =
              meta &&
              (meta.searchTerm !== undefined ||
                meta.caseSensitive !== undefined);

            if (paramsChanged || (tr.docChanged && searchTerm)) {
              results = findMatches(newState.doc, searchTerm, caseSensitive);
              if (currentIndex >= results.length)
                currentIndex = results.length > 0 ? results.length - 1 : 0;
            }

            const deco =
              searchTerm && results.length
                ? buildDeco(newState.doc, results, currentIndex)
                : DecorationSet.empty;

            return {
              searchTerm,
              replaceTerm,
              caseSensitive,
              results,
              currentIndex,
              deco,
            };
          },
        },
        props: {
          decorations(state) {
            return searchPluginKey.getState(state)?.deco;
          },
        },
      }),
    ];
  },
});
