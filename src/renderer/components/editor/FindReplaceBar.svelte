<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { tick, untrack } from "svelte";
  import { FindBar } from "../ui/find-bar";
  import { getSearchState } from "./searchExtension";

  interface Props {
    editor: Editor;
    scrollContainer?: HTMLDivElement | null;
    onClose: () => void;
  }

  let { editor, scrollContainer = null, onClose }: Props = $props();

  const initialQuery = untrack(() => {
    const selection = editor.state.selection;
    return selection.empty
      ? ""
      : editor.state.doc.textBetween(selection.from, selection.to, " ");
  });
  let query = $state(initialQuery.includes("\n") ? "" : initialQuery);
  let replacement = $state("");
  let caseSensitive = $state(false);
  let matchCount = $state(0);
  let currentMatch = $state(0);
  let findBarRef: FindBar | null = $state(null);

  function refresh() {
    const state = getSearchState(editor.state);
    matchCount = state?.results.length ?? 0;
    currentMatch =
      matchCount > 0 ? (state?.currentIndex ?? 0) + 1 : 0;
  }

  function scrollToCurrent() {
    const state = getSearchState(editor.state);
    if (!state || state.results.length === 0) return;
    const match = state.results[state.currentIndex];
    editor
      .chain()
      .setTextSelection({ from: match.from, to: match.to })
      .run();

    if (!scrollContainer) {
      editor.commands.scrollIntoView();
      return;
    }

    const coords = editor.view.coordsAtPos(match.from);
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetTop = coords.top - containerRect.top - 64;
    const targetBottom = coords.bottom - containerRect.bottom + 24;

    if (targetTop < 0) {
      scrollContainer.scrollBy({ top: targetTop, behavior: "smooth" });
    } else if (targetBottom > 0) {
      scrollContainer.scrollBy({ top: targetBottom, behavior: "smooth" });
    }
  }

  function runSearch(value: string) {
    query = value;
    editor.commands.setSearchTerm(query);
    scrollToCurrent();
    refresh();
  }

  function next() {
    editor.commands.findNextMatch();
    scrollToCurrent();
    void findBarRef?.focusInput(false);
    refresh();
  }

  function prev() {
    editor.commands.findPrevMatch();
    scrollToCurrent();
    void findBarRef?.focusInput(false);
    refresh();
  }

  function replaceOne() {
    editor.commands.replaceCurrentMatch();
    refresh();
  }

  function replaceAll() {
    editor.commands.replaceAllMatches();
    refresh();
  }

  function toggleCase(value: boolean) {
    caseSensitive = value;
    editor.commands.setSearchCaseSensitive(caseSensitive);
    scrollToCurrent();
    refresh();
  }

  function close() {
    editor.commands.clearSearch();
    onClose();
    editor.commands.focus();
  }

  // Seed from the current selection and focus on open. Re-run search whenever
  // the live document changes under us so the counter stays honest.
  $effect(() => {
    void tick().then(() => {
      void findBarRef?.focusInput();
      if (query) runSearch(query);
    });

    const onTransaction = () => refresh();
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
      editor.commands.clearSearch();
    };
  });
</script>

<FindBar
  bind:this={findBarRef}
  {query}
  current={currentMatch}
  total={matchCount}
  onQueryChange={runSearch}
  onNext={next}
  onPrev={prev}
  onClose={close}
  {caseSensitive}
  onCaseSensitiveChange={toggleCase}
  {replacement}
  onReplacementChange={(value) => {
    replacement = value;
    editor.commands.setReplaceTerm(value);
  }}
  onReplace={replaceOne}
  onReplaceAll={replaceAll}
/>
