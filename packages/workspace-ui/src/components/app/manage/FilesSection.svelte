<script lang="ts">
  import { untrack } from "svelte";
  import { Download as DownloadIcon, Upload as UploadIcon } from "@lucide/svelte";
  import type { AppFileView, AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { toasts } from "../../../lib/toasts";
  import { formatFileSize } from "../../files/lib/non-text-file";
  import { Button } from "../../ui/button";
  import { Progress } from "../../ui/progress";
  import ManageHeading from "./ManageHeading.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import { appTime } from "../lib/app-view";
  import { downloadFile, fileCreatedByText, fileDeleteConfirmText, uploadFile, uploadPercent, uploadRefusal, type FileUpload } from "./lib/app-file-transfer";

  /**
   * The app files (docs/plans/apps.md §4.3, §9.2): the files a person uploaded
   * in the app's UI or here, and the ones the backend wrote. The owner uploads,
   * downloads, and deletes.
   */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    return untrack(() => appsStore.files.watch(hostId, appId));
  });
  const files = $derived(appsStore.files.get(serverId, app.id));

  /** The files on their way to the app, and the ones that did not arrive. */
  let uploads = $state<FileUpload[]>([]);
  let isUploading = $state(false);
  let isDropTarget = $state(false);
  /** The file a download or a delete runs for; its buttons wait. */
  let busyFileId = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  // Bound to the app once, so each part of a file goes to the same app.
  function hostCall() {
    const hostId = serverId;
    const appId = app.id;
    return (name: string, argumentsJson: string) => appsStore.call(hostId, appId, name, argumentsJson);
  }

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
          await uploadFile(call, file, (sentBytes) => (row.sentBytes = sentBytes));
          row.sentBytes = file.size;
        } catch (cause) {
          row.error = cause instanceof Error ? cause.message : "The file was not sent.";
        }
      }
      // What arrived is in the list now; what did not arrive stays here with its reason.
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

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDropTarget = false;
    void upload([...(event.dataTransfer?.files ?? [])]);
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
      requestInputFocus();
    }
  }

  async function remove(file: AppFileView) {
    if (busyFileId || !confirm(fileDeleteConfirmText(file.name))) return;
    busyFileId = file.id;
    try {
      await appsStore.removeFile(serverId, app.id, file.id);
    } catch (cause) {
      toasts.error("The file was not deleted", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      busyFileId = null;
      requestInputFocus();
    }
  }
</script>

<ManageHeading title="Files" description="The files the app holds. One file is at most 64 MiB.">
  {#snippet actions()}
    <input bind:this={fileInput} type="file" multiple class="sr-only" tabindex="-1" aria-hidden="true" onchange={handleChosen} data-testid="app-file-input" />
    <Button size="xs" disabled={isUploading} onclick={() => fileInput?.click()} data-testid="app-file-upload">
      <UploadIcon size={12} /> {isUploading ? "Uploading…" : "Upload"}
    </Button>
  {/snippet}
</ManageHeading>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex min-w-0 flex-col gap-3 rounded-xl border border-dashed p-3 transition-colors duration-150 {isDropTarget ? 'border-(--solus-accent) bg-(--solus-accent-light)' : 'border-border/60'}"
  ondragover={(event) => {
    event.preventDefault();
    isDropTarget = true;
  }}
  ondragleave={() => (isDropTarget = false)}
  ondrop={handleDrop}
  data-testid="app-file-drop"
>
  <p class="m-0 text-xs text-muted-foreground">Drop files here to upload them, or use Upload.</p>

  {#if uploads.length > 0}
    <ul class="m-0 flex list-none flex-col gap-2 p-0" aria-label="Uploads" data-testid="app-file-uploads">
      {#each uploads as row, index (index)}
        <li class="flex min-w-0 flex-col gap-1 text-xs">
          <div class="flex min-w-0 items-baseline gap-2">
            <span class="min-w-0 flex-1 truncate">{row.name}</span>
            <span class="shrink-0 tabular-nums text-muted-foreground">{row.error ? "Not uploaded" : `${uploadPercent(row)}%`}</span>
          </div>
          {#if row.error}
            <p class="m-0 text-destructive text-pretty" role="alert">{row.error}</p>
          {:else}
            <Progress value={uploadPercent(row)} aria-label="Upload of {row.name}" />
          {/if}
        </li>
      {/each}
    </ul>
    {#if !isUploading}
      <Button size="xs" variant="ghost" class="self-start" onclick={() => (uploads = [])}>Clear</Button>
    {/if}
  {/if}

  <ManageSectionState
    count={files?.length}
    error={appsStore.files.errorFor(serverId, app.id)}
    empty="This app holds no file."
    onRetry={() => void appsStore.files.load(serverId, app.id)}
  >
    <ul class="m-0 flex list-none flex-col p-0" data-testid="app-files">
      {#each files ?? [] as file (file.id)}
        <li class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 py-2 last:border-b-0">
          <div class="flex min-w-40 flex-1 flex-col gap-0.5">
            <span class="min-w-0 truncate text-sm" title={file.name}>{file.name}</span>
            <span class="min-w-0 truncate text-xs text-muted-foreground">
              {file.type} · {formatFileSize(file.size)} · {fileCreatedByText(file.createdBy)} {appTime(file.createdAt)}
            </span>
          </div>
          <div class="flex shrink-0 gap-2">
            <Button size="xs" variant="outline" disabled={busyFileId !== null} onclick={() => void download(file)}>
              <DownloadIcon size={12} /> {busyFileId === file.id ? "Working…" : "Download"}
            </Button>
            <Button size="xs" variant="outline" disabled={busyFileId !== null} onclick={() => void remove(file)}>Delete</Button>
          </div>
        </li>
      {/each}
    </ul>
  </ManageSectionState>
</div>
