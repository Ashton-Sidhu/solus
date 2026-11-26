<script lang="ts">
  import { Check, ChevronLeft, ChevronRight, Copy, PanelRight, PenLine, X as CloseIcon } from "@lucide/svelte";
  import { browserSnapshotLabel } from "@solus/client-core/browser-snapshot-label";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import type { FilePreviewRequest } from "../../lib/filePreview";
  import { HostMediaUrl, type HostMediaRequest } from "../../lib/host-media-url.svelte";
  import { markdownAssetId, markdownImagePath } from "../conversation/lib/markdown-image";
  import { HostVideoPlayer, VideoPlayer } from "../ui/video-player";
  import ImageFilePreview from "./ImageFilePreview.svelte";
  import { hostPathBaseName, isAbsoluteHostPath } from "@solus/contracts/host-path";
  import { ImageGallery } from "./lib/image-gallery.svelte";
  import { copyImage } from "./lib/copy-image";
  import { Button } from "../ui/button";
  import { snapshotAddress, snapshotHref } from "../browser/lib/snapshot-card";
  import { isSnapshotPageOpen, openSnapshotPage } from "../browser/lib/snapshot-page";

  let { request, onclose }: { request: FilePreviewRequest; onclose: () => void } = $props();
  let dialog: HTMLDialogElement;
  const session = getWorkspaceContext();
  const gallery = $derived(new ImageGallery(request.gallery ?? [], request.path));
  const currentPath = $derived(gallery.path);
  /** The browser capture on screen, when the picture is one. */
  const snapshot = $derived(request.snapshots?.find((item) => snapshotHref(item) === currentPath));
  const label = $derived(snapshot ? browserSnapshotLabel(snapshot) : hostPathBaseName(currentPath.split(/[?#]/, 1)[0]) || "Media");
  const pageIsOpen = $derived(snapshot ? isSnapshotPageOpen(request.source?.serverId, snapshot) : false);
  const assetId = $derived(markdownAssetId(currentPath));
  const path = $derived(markdownImagePath(currentPath, request.source?.cwd ?? (isAbsoluteHostPath(currentPath) ? "/" : undefined)));
  const hostRequest = $derived<HostMediaRequest | null>(
    request.source?.serverId && (path || assetId)
      ? { serverId: request.source.serverId, path: path ?? undefined, assetId: assetId ?? undefined, ctx: request.source.ctx }
      : null,
  );
  const image = new HostMediaUrl(() => request.mediaKind === "video" ? null : hostRequest);
  const src = $derived(hostRequest ? image.url : currentPath);

  function navigate(event: KeyboardEvent) {
    if (gallery.paths.length < 2 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "ArrowLeft") gallery.previous();
    else gallery.next();
  }

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copy() {
    if (!src) return;
    try {
      await copyImage(src);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch (error) {
      toasts.error("Could not copy the image", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  let isOpeningPage = $state(false);
  async function openPage(annotate: boolean) {
    if (!snapshot || isOpeningPage) return;
    isOpeningPage = true;
    try {
      await openSnapshotPage(session, request.source?.serverId, snapshot, { annotate });
      dialog.close();
    } catch (error) {
      toasts.error("Could not open the captured page", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      isOpeningPage = false;
    }
  }

  $effect(() => {
    dialog.showModal();
    return () => clearTimeout(copyTimer);
  });
</script>

<dialog
  bind:this={dialog}
  aria-label={label}
  class="m-auto h-[min(85dvh,60rem)] w-[min(90vw,80rem)] max-w-none overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground shadow-xl backdrop:media-backdrop"
  {onclose}
  onkeydown={navigate}
  onclick={(event) => { if (event.target === dialog) dialog.close(); }}
>
  <div class="flex h-full min-h-0 flex-col">
    <header class="@container flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
      <div class="flex min-w-0 flex-1 items-baseline gap-2">
        <span class="min-w-0 shrink truncate text-workspace-chrome">{label}</span>
        <!-- Two worktrees serving one app differ only by port, so a capture
             states where it was taken. -->
        {#if snapshot}
          <span class="min-w-0 flex-1 truncate text-chrome-dense text-muted-foreground @max-[32rem]:hidden">{snapshotAddress(snapshot)}</span>
        {/if}
      </div>
      {#if gallery.paths.length > 1}
        <span role="status" class="text-workspace-chrome text-muted-foreground tabular-nums">{gallery.index + 1} / {gallery.paths.length}</span>
      {/if}
      <div class="flex shrink-0 items-center gap-1">
        {#if request.mediaKind !== "video" && src && !image.hasFailed}
          <Button variant="ghost" size="sm" class="text-workspace-chrome" aria-label={copied ? "Image copied" : "Copy image"} onclick={copy}>
            {#if copied}<Check />{:else}<Copy />{/if}
            <span class="@max-[40rem]:hidden">{copied ? "Copied" : "Copy"}</span>
          </Button>
        {/if}
        {#if snapshot}
          {#if pageIsOpen}
            <Button variant="ghost" size="sm" class="text-workspace-chrome" aria-label="Annotate page" disabled={isOpeningPage} onclick={() => openPage(true)}>
              <PenLine />
              <span class="@max-[40rem]:hidden">Annotate</span>
            </Button>
          {/if}
          <Button variant="outline" size="sm" class="text-workspace-chrome" aria-label="Open in pane" disabled={isOpeningPage} onclick={() => openPage(false)}>
            <PanelRight />
            <span class="@max-[40rem]:hidden">Open in pane</span>
          </Button>
        {/if}
      </div>
      <!-- svelte-ignore a11y_autofocus (The modal puts keyboard focus on its close control.) -->
      <button type="button" aria-label="Close media preview" autofocus class="rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onclick={() => dialog.close()}><CloseIcon size={18} /></button>
    </header>
    <div class="relative flex min-h-0 flex-1">
      {#if gallery.paths.length > 1}
        <button type="button" aria-label="Previous image" title="Previous image (Left arrow)" disabled={!gallery.hasPrevious} class="absolute top-1/2 left-2 z-10 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-30 pointer-coarse:size-11" onclick={() => gallery.previous()}><ChevronLeft size={20} /></button>
        <button type="button" aria-label="Next image" title="Next image (Right arrow)" disabled={!gallery.hasNext} class="absolute top-1/2 right-2 z-10 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-30 pointer-coarse:size-11" onclick={() => gallery.next()}><ChevronRight size={20} /></button>
      {/if}
    {#if request.mediaKind === "video"}
      <div class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {#if hostRequest}
          <HostVideoPlayer request={hostRequest} {label} class="w-full max-w-4xl" />
        {:else}
          <VideoPlayer src={request.path} {label} class="w-full max-w-4xl" />
        {/if}
      </div>
    {:else if image.hasFailed}
      <div role="alert" class="m-auto p-6 text-center text-workspace-chrome">
        <p>The host could not send this image.</p>
        <button type="button" class="mt-3 rounded-md px-3 py-2 hover:bg-muted" onclick={() => { void image.retry().catch(() => {}); }}>Try again</button>
      </div>
    {:else if src}
      {#key src}<ImageFilePreview {src} title={label} />{/key}
    {:else}
      <p role="status" class="m-auto p-6 text-workspace-chrome text-muted-foreground">Loading image…</p>
    {/if}
    </div>
  </div>
</dialog>
