<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { FileUp as DropIcon, Upload as UploadIcon, X as DismissIcon } from "@lucide/svelte";
  import type { AppFileView, AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { messageTimestampClock } from "../../../lib/shared-clock";
  import { copyText, toasts } from "../../../lib/toasts";
  import { formatFileSize } from "../../files/lib/non-text-file";
  import { Button } from "../../ui/button";
  import FileIcon from "../../ui/file-icon/FileIcon.svelte";
  import { MiddleTruncate } from "../../ui/middle-truncate";
  import { Progress } from "../../ui/progress";
  import { SearchField } from "../../ui/search-field";
  import SortMenu from "../../ui/SortMenu.svelte";
  import AppFileInspector from "./AppFileInspector.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import { downloadFile, uploadFile, uploadPercent, uploadRefusal, uploadsHeading, type FileUpload } from "./lib/app-file-transfer";
  import {
    FILE_ORDER_OPTIONS,
    FILE_PAGE,
    fileAddedText,
    fileFigures,
    fileSourceOptions,
    fileSourceText,
    fileTypeName,
    fileTypeTile,
    visibleFiles,
    type FileOrder,
    type FileSourceFilter,
  } from "./lib/app-file-list";
  import { FilePreview } from "./lib/app-file-preview.svelte";
  import { FILE_TILE_TONES } from "./lib/file-tile-styles";

  /**
   * The app files as a file browser (docs/plans/apps.md §4.3, §9.2): the files
   * people uploaded and the ones the backend wrote. Figures sum them up; a
   * search, a source, and an order narrow the plain table; the inspector beside
   * it previews the selected file and downloads, copies the id of, or deletes
   * it. A file dropped anywhere on the section uploads.
   */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    return untrack(() => appsStore.files.watch(hostId, appId));
  });
  const files = $derived(appsStore.files.get(serverId, app.id));

  // "3 min ago" moves with the clock, once a minute.
  let nowMs = $state(Date.now());
  $effect(() => messageTimestampClock.subscribe((now) => (nowMs = now)));

  let query = $state("");
  let source = $state<FileSourceFilter>("all");
  let order = $state<FileOrder>("newest");
  let shownCount = $state(FILE_PAGE);
  const figures = $derived(fileFigures(files ?? [], nowMs));
  const sourceOptions = $derived(fileSourceOptions(files ?? []));
  const matching = $derived(visibleFiles(files ?? [], query, source, order));
  const shown = $derived(matching.slice(0, shownCount));

  /** The file the person chose; the first row until they choose, or when theirs is gone. */
  let chosenFileId = $state<string | null>(null);
  const selected = $derived(matching.find((file) => file.id === chosenFileId) ?? shown[0] ?? null);

  /** The files on their way to the app, and the ones that did not arrive. */
  let uploads = $state<FileUpload[]>([]);
  let isUploading = $state(false);
  /** Drag events fire for each child the pointer crosses: the depth says when it left the section. */
  let dragDepth = $state(0);
  const isDropTarget = $derived(dragDepth > 0);
  /** The file a download or a delete runs for; its buttons wait. */
  let busyFileId = $state<string | null>(null);
  let copiedFileId = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let table = $state<HTMLElement | null>(null);

  // Bound to the app once, so each part of a file goes to the same app.
  function hostCall() {
    const hostId = serverId;
    const appId = app.id;
    return (name: string, argumentsJson: string) => appsStore.call(hostId, appId, name, argumentsJson);
  }

  const preview = new FilePreview();
  onDestroy(() => preview.dispose());
  // The preview follows the selection: it reads the selected file through the app's `@files/read`.
  $effect(() => {
    const file = selected;
    untrack(() => preview.show(hostCall(), file));
  });

  /** Sends the files one at a time: each one is many calls, and the host takes them in order. */
  async function upload(chosen: File[]) {
    if (isUploading || chosen.length === 0) return;
    isUploading = true;
    uploads = chosen.map((file) => ({ name: file.name, size: file.size, sentBytes: 0, error: uploadRefusal(file) }));
    const call = hostCall();
    try {
      for (const [index, file] of chosen.entries()) {
        const row = uploads[index];
        if (!row || row.error) continue;
        try {
          const sent = await uploadFile(call, file, (sentBytes) => (row.sentBytes = sentBytes));
          row.sentBytes = file.size;
          chosenFileId = sent.id;
        } catch (cause) {
          row.error = cause instanceof Error ? cause.message : "The file was not sent.";
        }
      }
      // What arrived is in the table now; what did not arrive stays here with its reason.
      uploads = uploads.filter((row) => row.error !== null);
      await appsStore.files.load(serverId, app.id);
    } finally {
      isUploading = false;
      requestInputFocus();
    }
  }

  function handleChosen(event: Event & { currentTarget: HTMLInputElement }) {
    const chosen = [...(event.currentTarget.files ?? [])];
    // The same file can be chosen again after a failure.
    event.currentTarget.value = "";
    void upload(chosen);
  }

  function carriesFiles(event: DragEvent) {
    return event.dataTransfer?.types.includes("Files") ?? false;
  }

  function handleDrop(event: DragEvent) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    void upload([...(event.dataTransfer?.files ?? [])]);
  }

  /** Up and Down move the selection along the rows; Home and End go to the ends. */
  async function handleTableKeydown(event: KeyboardEvent) {
    const index = shown.findIndex((file) => file.id === selected?.id);
    const next =
      event.key === "ArrowDown" ? Math.min(shown.length - 1, index + 1)
      : event.key === "ArrowUp" ? Math.max(0, index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? shown.length - 1
      : null;
    if (next === null || !shown[next]) return;
    event.preventDefault();
    chosenFileId = shown[next].id;
    await tick();
    table?.querySelector<HTMLElement>(`[data-file-id="${chosenFileId}"]`)?.focus();
  }

  /** The source control is one tab stop; the arrow keys choose within it. */
  function handleSourceKeydown(event: KeyboardEvent & { currentTarget: HTMLElement }) {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = sourceOptions.findIndex((option) => option.value === source);
    const next = sourceOptions[(index + delta + sourceOptions.length) % sourceOptions.length]!;
    source = next.value;
    event.currentTarget.querySelector<HTMLElement>(`[data-source="${next.value}"]`)?.focus();
  }

  async function download(file: AppFileView) {
    if (busyFileId) return;
    busyFileId = file.id;
    try {
      await downloadFile(hostCall(), file);
    } catch (cause) {
      toasts.error("The file was not downloaded", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      busyFileId = null;
    }
  }

  async function copyId(file: AppFileView) {
    await copyText(file.id);
    copiedFileId = file.id;
    setTimeout(() => {
      if (copiedFileId === file.id) copiedFileId = null;
    }, 1500);
  }

  async function remove(file: AppFileView) {
    if (busyFileId) return;
    busyFileId = file.id;
    try {
      await appsStore.removeFile(serverId, app.id, file.id);
      if (chosenFileId === file.id) chosenFileId = null;
    } catch (cause) {
      toasts.error("The file was not deleted", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      busyFileId = null;
      await tick();
      table?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="relative flex min-w-0 flex-col gap-6"
  ondragenter={(event) => {
    if (carriesFiles(event)) dragDepth += 1;
  }}
  ondragover={(event) => {
    if (carriesFiles(event)) event.preventDefault();
  }}
  ondragleave={(event) => {
    if (carriesFiles(event)) dragDepth = Math.max(0, dragDepth - 1);
  }}
  ondrop={handleDrop}
  data-testid="app-file-drop"
>
  <input bind:this={fileInput} type="file" multiple class="sr-only" tabindex="-1" aria-hidden="true" onchange={handleChosen} data-testid="app-file-input" />

  <!-- The figures, plain and large, with Upload at the end of the row. -->
  <div class="flex min-w-0 flex-wrap items-end gap-x-12 gap-y-4 px-1">
    {#if figures}
      <dl class="m-0 flex min-w-0 flex-wrap items-end gap-x-12 gap-y-4" data-testid="app-file-figures">
        {#each [figures.count, figures.size, figures.newest] as figure, index (index)}
          <!-- The words name the figure, so they come first; the figure shows above them. -->
          <div class="flex min-w-0 flex-col-reverse gap-0.5">
            <dt class="max-w-72 truncate text-[13px] leading-4 text-(--solus-text-tertiary)" title={figure.detail}>{figure.detail}</dt>
            <dd class="m-0 text-[30px] leading-9 font-semibold tracking-[-0.02em] text-foreground tabular-nums">{figure.value}</dd>
          </div>
        {/each}
      </dl>
    {/if}
    <span class="min-w-0 flex-1"></span>
    <Button class="h-8.5 rounded-[10px]" disabled={isUploading} onclick={() => fileInput?.click()} data-testid="app-file-upload">
      <UploadIcon /> {isUploading ? "Uploading…" : "Upload"}
    </Button>
  </div>

  {#if uploads.length > 0}
    <!-- The uploads: each file's progress, or why it did not arrive. Plain on the page. -->
    <section class="flex min-w-0 flex-col" aria-label="Uploads" data-testid="app-file-uploads">
      <div class="flex min-h-9 items-center justify-between gap-3 border-b border-border/60 px-1">
        <span class="text-[13px] font-medium {isUploading ? '' : 'text-destructive'}" role="status">{uploadsHeading(uploads, isUploading)}</span>
        {#if !isUploading}
          <Button size="icon-xs" variant="ghost" aria-label="Clear the uploads" title="Clear" onclick={() => (uploads = [])}><DismissIcon /></Button>
        {/if}
      </div>
      <ul class="m-0 flex list-none flex-col p-0">
        {#each uploads as row, index (index)}
          <li class="flex min-w-0 items-start gap-3 px-1 py-2.5">
            <FileIcon path={row.name} size={16} class="mt-0.5" />
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
              <div class="flex min-w-0 items-baseline gap-3 text-[13px]">
                <MiddleTruncate value={row.name} class="min-w-0 flex-1" />
                <span class="shrink-0 text-xs tabular-nums text-(--solus-text-secondary)">
                  {row.error ? "Not uploaded" : `${formatFileSize(row.sentBytes)} of ${formatFileSize(row.size)}`}
                </span>
              </div>
              {#if row.error}
                <p class="m-0 text-xs text-pretty text-destructive" role="alert">{row.error}</p>
              {:else}
                <Progress value={uploadPercent(row)} aria-label="Upload of {row.name}" />
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if files?.length === 0}
    <!-- No file yet: the whole place is where to drop one. -->
    <div
      class="flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center transition-colors duration-150 {isDropTarget ? 'border-(--solus-accent) bg-(--solus-accent-light)' : 'border-border'}"
      data-testid="app-files-empty"
    >
      <span class="grid size-11 place-items-center rounded-xl bg-[var(--wash-2)] text-(--solus-text-secondary)" aria-hidden="true"><DropIcon size={20} strokeWidth={1.5} /></span>
      <div class="flex max-w-sm flex-col gap-1.5">
        <p class="m-0 text-[15px] font-medium tracking-[-0.01em] text-foreground">{isDropTarget ? "Drop to upload" : "No files yet"}</p>
        <p class="m-0 text-[13px] text-pretty text-(--solus-text-secondary)">Drop files here, or choose them. The files the app's backend writes show here too. A file is at most 64 MiB.</p>
      </div>
      <Button size="sm" variant="outline" disabled={isUploading} onclick={() => fileInput?.click()}><UploadIcon /> Choose files</Button>
    </div>
  {:else}
    <ManageSectionState
      count={files?.length}
      error={appsStore.files.errorFor(serverId, app.id)}
      empty="This app holds no file."
      onRetry={() => void appsStore.files.load(serverId, app.id)}
    >
      <div class="flex min-w-0 flex-col gap-5">
        <!-- The toolbar: search, source, order. -->
        <div class="flex min-w-0 flex-wrap items-center gap-2.5">
          <SearchField bind:value={query} placeholder="Search files" class="h-9 max-w-75 flex-none basis-75 rounded-full px-3.5 @max-[40rem]/pane:max-w-none @max-[40rem]/pane:basis-full" />
          <!-- svelte-ignore a11y_interactive_supports_focus -->
          <div class="flex h-9 shrink-0 items-center gap-0.5 rounded-full bg-[var(--wash-2)] p-0.75" role="radiogroup" aria-label="Source" tabindex="-1" onkeydown={handleSourceKeydown}>
            {#each sourceOptions as option (option.value)}
              {@const isActive = option.value === source}
              <button
                type="button"
                role="radio"
                aria-checked={isActive}
                tabindex={isActive ? 0 : -1}
                data-source={option.value}
                class="flex h-7.5 cursor-pointer items-center rounded-full border-0 px-3.5 text-[13px] whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring {isActive
                  ? 'bg-background font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)] dark:bg-card'
                  : 'bg-transparent text-(--solus-text-tertiary) hover:text-foreground'}"
                onclick={() => (source = option.value)}
              >
                {option.label}
              </button>
            {/each}
          </div>
          <span class="min-w-0 flex-1"></span>
          <SortMenu options={FILE_ORDER_OPTIONS} bind:value={order} ariaLabel="Order" class="h-9 rounded-full border border-border px-3.5" />
        </div>

        <div class="flex min-w-0 items-start gap-7 @max-[52rem]/pane:flex-col">
          <!-- The table: plain on the page. -->
          <div class="flex min-w-0 flex-1 flex-col gap-0.5 @max-[52rem]/pane:w-full">
            <div class="mb-1 flex h-10 min-w-0 items-center gap-3 border-b border-border px-5 text-xs leading-4 font-medium tracking-[0.06em] text-(--solus-text-tertiary) uppercase" aria-hidden="true">
              <span class="min-w-0 flex-1">Name</span>
              <span class="w-19 shrink-0 @max-[40rem]/pane:hidden">Type</span>
              <span class="w-32 shrink-0 @max-[40rem]/pane:hidden">Source</span>
              <span class="w-15 shrink-0 text-right">Size</span>
              <span class="w-16.5 shrink-0 text-right @max-[30rem]/pane:hidden">Added</span>
            </div>

            {#if shown.length === 0}
              <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <p class="m-0 text-[13px] text-(--solus-text-secondary)">No file matches{query.trim() ? ` “${query.trim()}”` : " this source"}.</p>
                <Button
                  size="xs"
                  variant="outline"
                  onclick={() => {
                    query = "";
                    source = "all";
                  }}>Show all files</Button
                >
              </div>
            {:else}
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <div bind:this={table} class="flex min-w-0 flex-col gap-0.5" role="listbox" aria-label="App files" tabindex="-1" onkeydown={(event) => void handleTableKeydown(event)} data-testid="app-files">
                {#each shown as file (file.id)}
                  {@const tile = fileTypeTile(file)}
                  {@const isSelected = file.id === selected?.id}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    tabindex={isSelected ? 0 : -1}
                    data-file-id={file.id}
                    class="flex h-12 w-full min-w-0 shrink-0 cursor-pointer items-center gap-3 overflow-hidden rounded-[10px] border-0 px-3.5 text-left text-[13.5px] leading-4.5 transition-colors duration-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring {isSelected
                      ? 'bg-[var(--wash-2)]'
                      : 'bg-transparent hover:bg-[var(--wash-1)]'}"
                    onclick={() => (chosenFileId = file.id)}
                    ondblclick={() => void download(file)}
                    data-testid="app-file"
                  >
                    <span class="flex min-w-0 flex-1 items-center gap-3 pl-1.5">
                      <span class="flex size-7 shrink-0 items-center justify-center rounded-[7px] text-[9px] leading-3 font-bold tracking-[0.04em] {FILE_TILE_TONES[tile.tone]}" aria-hidden="true">{tile.label}</span>
                      <MiddleTruncate value={file.name} class="min-w-0 flex-1 text-foreground {isSelected ? 'font-medium' : ''}" />
                    </span>
                    <span class="w-19 shrink-0 truncate text-(--solus-text-secondary) @max-[40rem]/pane:hidden">{fileTypeName(file)}</span>
                    <span class="w-32 shrink-0 truncate text-(--solus-text-secondary) @max-[40rem]/pane:hidden">{fileSourceText(file.createdBy)}</span>
                    <span class="w-15 shrink-0 text-right text-(--solus-text-secondary) tabular-nums">{formatFileSize(file.size)}</span>
                    <span class="w-18 shrink-0 truncate pr-1.5 text-right text-(--solus-text-secondary) @max-[30rem]/pane:hidden" title={new Date(file.createdAt).toLocaleString()}>{fileAddedText(file.createdAt, nowMs)}</span>
                  </button>
                {/each}
              </div>
            {/if}

            <div class="mt-1 flex min-h-11 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-5 text-[13px] leading-4">
              <span class="text-(--solus-text-tertiary) tabular-nums" role="status">{shown.length} of {matching.length}</span>
              {#if shown.length < matching.length}
                <Button size="xs" variant="ghost" onclick={() => (shownCount += FILE_PAGE)}>Show more</Button>
              {/if}
              <span class="min-w-0 flex-1"></span>
              <span class="text-(--solus-text-tertiary) @max-[40rem]/pane:hidden">Drop files anywhere on this page to upload</span>
            </div>
          </div>

          {#if selected}
            {#key selected.id}
              <AppFileInspector
                file={selected}
                {preview}
                {nowMs}
                isBusy={busyFileId === selected.id}
                isCopied={copiedFileId === selected.id}
                onCopyId={() => void copyId(selected)}
                onDownload={() => void download(selected)}
                onDelete={() => void remove(selected)}
              />
            {/key}
          {/if}
        </div>
      </div>
    </ManageSectionState>
  {/if}

  {#if isDropTarget && (files?.length ?? 0) > 0}
    <!-- Over a table, the drop target is a layer on the whole section. -->
    <div class="pointer-events-none absolute -inset-3 z-10 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-(--solus-accent) bg-[color-mix(in_oklch,var(--background)_88%,transparent)] dark:bg-[color-mix(in_oklch,var(--card)_88%,transparent)]" aria-hidden="true">
      <span class="grid size-11 place-items-center rounded-xl bg-(--solus-accent-light) text-(--solus-accent)"><DropIcon size={20} strokeWidth={1.5} /></span>
      <p class="m-0 text-[15px] font-medium text-foreground">Drop to upload to {app.name}</p>
      <p class="m-0 text-xs text-(--solus-text-secondary)">A file is at most 64 MiB.</p>
    </div>
  {/if}
</div>
