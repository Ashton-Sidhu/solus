<script lang="ts">
  import { ChevronLeft as PrevIcon, ChevronRight as NextIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import FilePasswordPrompt from "./FilePasswordPrompt.svelte";
  import {
    openProtectedDocument,
    type DecodedDocumentPreview,
  } from "./lib/document-preview";
  import {
    isProtectedPreviewError,
    PROTECTED_PREVIEW_MAX_BYTES,
    readBoundedResponse,
    type ProtectedPreviewKind,
  } from "./lib/protected-preview-error";

  let {
    src,
    title,
    kind,
  }: {
    src: string;
    title: string;
    kind: Exclude<ProtectedPreviewKind, "zip">;
  } = $props();

  type DocumentViewState =
    | { status: "loading" }
    | { status: "locked"; bytes: ArrayBuffer; incorrect: boolean }
    | { status: "ready"; document: DecodedDocumentPreview }
    | { status: "error"; message: string };

  let state = $state<DocumentViewState>({ status: "loading" });
  let activeSheetIndex = $state(0);
  let activeChapterIndex = $state(0);
  let abortController: AbortController | null = null;

  async function decode(bytes: ArrayBuffer, signal: AbortSignal, password?: string) {
    try {
      const document = await openProtectedDocument(kind, bytes, password, signal);
      if (signal.aborted) return;
      activeSheetIndex = 0;
      activeChapterIndex = 0;
      state = { status: "ready", document };
    } catch (cause) {
      if (signal.aborted) return;
      if (
        isProtectedPreviewError(cause) &&
        (cause.code === "password-required" || cause.code === "password-incorrect")
      ) {
        state = { status: "locked", bytes, incorrect: cause.code === "password-incorrect" };
        return;
      }
      state = {
        status: "error",
        message: isProtectedPreviewError(cause)
          ? cause.message
          : "This document could not be displayed.",
      };
    }
  }

  $effect(() => {
    const url = src;
    const controller = new AbortController();
    abortController = controller;
    state = { status: "loading" };
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("The host could not send this file.");
        const bytes = await readBoundedResponse(response, PROTECTED_PREVIEW_MAX_BYTES, controller.signal);
        if (controller.signal.aborted) return;
        await decode(bytes, controller.signal);
      } catch (cause) {
        if (controller.signal.aborted) return;
        state = {
          status: "error",
          message: isProtectedPreviewError(cause)
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : "The host could not send this file.",
        };
      }
    })();
    return () => {
      controller.abort();
      if (abortController === controller) abortController = null;
    };
  });

  function unlock(password: string) {
    if (state.status !== "locked" || !abortController || abortController.signal.aborted) return;
    const bytes = state.bytes;
    state = { status: "loading" };
    void decode(bytes, abortController.signal, password);
  }
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="document-file-preview" aria-label={title}>
  {#if state.status === "loading"}
    <ContentSkeleton label="Loading document" preview />
  {:else if state.status === "locked"}
    <FilePasswordPrompt incorrect={state.incorrect} onSubmit={unlock} />
  {:else if state.status === "error"}
    <p role="alert" class="m-auto p-6 text-center text-workspace-chrome text-(--solus-status-error)">
      {state.message}
    </p>
  {:else if state.document.kind === "document"}
    <div class="min-h-0 flex-1 overflow-auto bg-(--solus-surface-secondary) p-6">
      <article class="mx-auto flex max-w-3xl flex-col gap-3 rounded-lg border border-(--solus-container-border) bg-background p-6 text-sm leading-relaxed text-(--solus-text-primary)">
        {#if state.document.blocks.length === 0}
          <p class="text-(--solus-text-tertiary)">This document has no text content.</p>
        {:else}
          {#each state.document.blocks as block, index (index)}
            {#if block.kind === "heading"}
              <h2 class="font-semibold text-(--solus-text-primary) {block.level === 1 ? 'text-lg' : 'text-base'}">
                {block.text}
              </h2>
            {:else if block.kind === "paragraph"}
              <p class="whitespace-pre-wrap break-words">{block.text}</p>
            {:else}
              <div class="overflow-x-auto">
                <table class="w-full border-collapse text-xs">
                  <tbody>
                    {#each block.rows as row, rowIndex (rowIndex)}
                      <tr class="border-b border-(--solus-container-border)">
                        {#each row as cell, cellIndex (cellIndex)}
                          <td class="border-r border-(--solus-container-border) px-2 py-1 last:border-r-0">
                            {cell}
                          </td>
                        {/each}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          {/each}
        {/if}
      </article>
    </div>
  {:else if state.document.kind === "spreadsheet"}
    {@const sheet = state.document.sheets[activeSheetIndex] ?? state.document.sheets[0]}
    <div class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-(--solus-container-border) px-3 py-1.5">
      {#each state.document.sheets as item, index (item.name + index)}
        <button
          type="button"
          class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors {index === activeSheetIndex ? 'bg-muted text-(--solus-text-primary)' : 'text-(--solus-text-tertiary) hover:bg-muted/60'}"
          onclick={() => { activeSheetIndex = index; }}
        >
          {item.name}
        </button>
      {/each}
    </div>
    <div class="min-h-0 flex-1 overflow-auto bg-(--solus-surface-secondary) p-4">
      {#if sheet}
        <table class="w-full border-collapse rounded-md border border-(--solus-container-border) bg-background text-xs">
          <tbody>
            {#each sheet.rows as row, rowIndex (rowIndex)}
              <tr class="border-b border-(--solus-container-border)">
                {#each row as cell, cellIndex (cellIndex)}
                  <td class="border-r border-(--solus-container-border) px-2.5 py-1.5 text-(--solus-text-primary) last:border-r-0">
                    {cell}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
        {#if sheet.truncated}
          <p class="mt-2 text-xs text-(--solus-text-tertiary)">Showing first 500 rows.</p>
        {/if}
      {/if}
    </div>
  {:else if state.document.kind === "presentation"}
    <div class="min-h-0 flex-1 overflow-auto bg-(--solus-surface-secondary) p-6">
      <div class="mx-auto flex max-w-3xl flex-col gap-4">
        {#each state.document.slides as slide (slide.index)}
          <section class="rounded-lg border border-(--solus-container-border) bg-background p-5">
            <p class="mb-2 text-xs font-medium text-(--solus-text-tertiary) tabular-nums">
              Slide {slide.index}
            </p>
            {#if slide.lines.length === 0}
              <p class="text-xs text-(--solus-text-tertiary)">No text on this slide.</p>
            {:else}
              <div class="flex flex-col gap-1.5 text-sm text-(--solus-text-primary)">
                {#each slide.lines as line, lineIndex (lineIndex)}
                  <p class="whitespace-pre-wrap break-words">{line}</p>
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      </div>
    </div>
  {:else}
    {@const chapter = state.document.chapters[activeChapterIndex] ?? state.document.chapters[0]}
    <div class="flex shrink-0 items-center justify-between gap-2 border-b border-(--solus-container-border) px-3 py-1.5 text-xs text-(--solus-text-tertiary)">
      <span class="min-w-0 truncate text-(--solus-text-primary)">
        {state.document.title} — {chapter?.title ?? ""}
      </span>
      <div class="flex shrink-0 items-center gap-1 tabular-nums">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous section"
          disabled={activeChapterIndex <= 0}
          onclick={() => { activeChapterIndex = Math.max(0, activeChapterIndex - 1); }}
        >
          <PrevIcon />
        </Button>
        <span>{activeChapterIndex + 1} / {state.document.chapters.length}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next section"
          disabled={activeChapterIndex >= state.document.chapters.length - 1}
          onclick={() => { activeChapterIndex = Math.min(state.document.chapters.length - 1, activeChapterIndex + 1); }}
        >
          <NextIcon />
        </Button>
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-auto bg-(--solus-surface-secondary) p-6">
      {#if chapter}
        <article class="mx-auto flex max-w-3xl flex-col gap-3 rounded-lg border border-(--solus-container-border) bg-background p-6 text-sm leading-relaxed text-(--solus-text-primary)">
          {#each chapter.paragraphs as paragraph, index (index)}
            <p class="whitespace-pre-wrap break-words">{paragraph}</p>
          {/each}
        </article>
      {/if}
    </div>
  {/if}
</div>
