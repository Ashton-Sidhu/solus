<script lang="ts">
  import { File as FileOutlineIcon, Folder as FolderIcon } from "@lucide/svelte";
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import { Input } from "../ui/input";
  import FilePasswordPrompt from "./FilePasswordPrompt.svelte";
  import { formatFileSize } from "./lib/non-text-file";
  import {
    isProtectedPreviewError,
    PROTECTED_PREVIEW_MAX_BYTES,
    readBoundedResponse,
  } from "./lib/protected-preview-error";
  import {
    decodeUtf8Preview,
    readBoundedZip,
    type ZipArchiveEntry,
  } from "./lib/zip-archive";

  let { src, title }: { src: string; title: string } = $props();

  type ZipViewState =
    | { status: "loading" }
    | { status: "locked"; bytes: ArrayBuffer; incorrect: boolean }
    | { status: "ready"; entries: Array<{ path: string; entry: ZipArchiveEntry }> }
    | { status: "error"; message: string };

  let state = $state<ZipViewState>({ status: "loading" });
  let filter = $state("");
  let selectedPath = $state<string | null>(null);
  let abortController: AbortController | null = null;

  async function openArchive(bytes: ArrayBuffer, signal: AbortSignal, password?: string) {
    try {
      const files = await readBoundedZip(bytes, { password, signal });
      if (signal.aborted) return;
      const entries = [...files]
        .map(([path, entry]) => ({ path, entry }))
        .sort((a, b) => a.path.localeCompare(b.path));
      state = { status: "ready", entries };
      const firstFile = entries.find((item) => !item.entry.directory);
      selectedPath = firstFile?.path ?? null;
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
          : "This ZIP archive could not be displayed.",
      };
    }
  }

  $effect(() => {
    const url = src;
    const controller = new AbortController();
    abortController = controller;
    state = { status: "loading" };
    filter = "";
    selectedPath = null;
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("The host could not send this archive.");
        const bytes = await readBoundedResponse(response, PROTECTED_PREVIEW_MAX_BYTES, controller.signal);
        if (controller.signal.aborted) return;
        await openArchive(bytes, controller.signal);
      } catch (cause) {
        if (controller.signal.aborted) return;
        state = {
          status: "error",
          message: isProtectedPreviewError(cause)
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : "The host could not send this archive.",
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
    void openArchive(bytes, abortController.signal, password);
  }

  const filteredEntries = $derived.by(() => {
    if (state.status !== "ready") return [];
    const query = filter.trim().toLowerCase();
    if (!query) return state.entries;
    return state.entries.filter((item) => item.path.toLowerCase().includes(query));
  });

  const selectedItem = $derived.by(() => {
    if (state.status !== "ready" || !selectedPath) return null;
    return state.entries.find((item) => item.path === selectedPath) ?? null;
  });

  const selectedText = $derived.by(() => {
    if (!selectedItem || selectedItem.entry.directory) return null;
    return decodeUtf8Preview(selectedItem.entry.bytes);
  });
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="zip-file-preview" aria-label={title}>
  {#if state.status === "loading"}
    <ContentSkeleton label="Loading archive" preview />
  {:else if state.status === "locked"}
    <FilePasswordPrompt incorrect={state.incorrect} onSubmit={unlock} />
  {:else if state.status === "error"}
    <p role="alert" class="m-auto p-6 text-center text-workspace-chrome text-(--solus-status-error)">
      {state.message}
    </p>
  {:else}
    <div class="flex min-h-0 flex-1 flex-col @min-[42rem]:flex-row">
      <div class="flex min-h-0 w-full flex-col border-b border-(--solus-container-border) @min-[42rem]:w-64 @min-[42rem]:shrink-0 @min-[42rem]:border-r @min-[42rem]:border-b-0">
        <div class="border-b border-(--solus-container-border) p-2">
          <Input
            type="search"
            bind:value={filter}
            placeholder="Filter archive entries"
            aria-label="Filter archive entries"
            dictation={false}
          />
        </div>
        <div class="min-h-0 flex-1 overflow-auto p-1" role="listbox" aria-label="Archive entries">
          {#each filteredEntries as item (item.path)}
            <button
              type="button"
              role="option"
              aria-selected={selectedPath === item.path}
              disabled={item.entry.directory}
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-workspace-chrome transition-colors hover:bg-muted disabled:opacity-60 {selectedPath === item.path ? 'bg-muted text-(--solus-text-primary)' : 'text-(--solus-text-secondary)'}"
              onclick={() => { selectedPath = item.path; }}
            >
              {#if item.entry.directory}
                <FolderIcon size={15} class="shrink-0 text-(--solus-text-tertiary)" />
              {:else}
                <FileOutlineIcon size={15} class="shrink-0 text-(--solus-text-tertiary)" />
              {/if}
              <span class="min-w-0 flex-1 truncate">{item.path}</span>
              {#if !item.entry.directory}
                <span class="shrink-0 text-xs text-(--solus-text-tertiary) tabular-nums">
                  {formatFileSize(item.entry.size)}
                </span>
              {/if}
            </button>
          {/each}
          {#if filteredEntries.length === 0}
            <p class="p-3 text-center text-xs text-(--solus-text-tertiary)">No matching entries.</p>
          {/if}
        </div>
      </div>
      <div class="flex min-h-0 flex-1 flex-col overflow-auto bg-(--solus-surface-secondary)">
        {#if !selectedItem}
          <p class="m-auto p-6 text-center text-workspace-chrome text-(--solus-text-tertiary)">
            Select a file in the archive to preview it.
          </p>
        {:else if selectedText}
          <div class="flex shrink-0 items-center justify-between border-b border-(--solus-container-border) px-4 py-1.5 text-xs text-(--solus-text-tertiary)">
            <span class="truncate">{selectedItem.path}</span>
            <span class="shrink-0 tabular-nums">
              {selectedText.truncated ? "Truncated · " : ""}{formatFileSize(selectedItem.entry.size)}
            </span>
          </div>
          <pre class="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-(--solus-text-primary) whitespace-pre-wrap break-words">{selectedText.text}</pre>
        {:else}
          <div class="m-auto flex flex-col items-center gap-1 p-6 text-center">
            <p class="text-workspace-chrome text-(--solus-text-primary)">{selectedItem.path}</p>
            <p class="text-xs text-(--solus-text-tertiary)">
              Binary entry ({formatFileSize(selectedItem.entry.size)}).
            </p>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
