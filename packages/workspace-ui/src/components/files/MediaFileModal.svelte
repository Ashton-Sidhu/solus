<script lang="ts">
  import { X as CloseIcon } from "@lucide/svelte";
  import type { FilePreviewRequest } from "../../lib/filePreview";
  import { HostMediaUrl, type HostMediaRequest } from "../../lib/host-media-url.svelte";
  import { markdownAssetId, markdownImagePath } from "../conversation/lib/markdown-image";
  import { HostVideoPlayer, VideoPlayer } from "../ui/video-player";
  import ImageFilePreview from "./ImageFilePreview.svelte";

  let { request, onclose }: { request: FilePreviewRequest; onclose: () => void } = $props();
  let dialog: HTMLDialogElement;
  const label = $derived(request.path.split(/[?#]/, 1)[0].split("/").pop() || "Media");
  const assetId = $derived(markdownAssetId(request.path));
  const path = $derived(markdownImagePath(request.path, request.source?.cwd ?? (request.path.startsWith("/") ? "/" : undefined)));
  const hostRequest = $derived<HostMediaRequest | null>(
    request.source?.serverId && (path || assetId)
      ? { serverId: request.source.serverId, path: path ?? undefined, assetId: assetId ?? undefined, ctx: request.source.ctx }
      : null,
  );
  const image = new HostMediaUrl(() => request.mediaKind === "video" ? null : hostRequest);
  const src = $derived(hostRequest ? image.url : request.path);

  $effect(() => {
    dialog.showModal();
  });
</script>

<dialog
  bind:this={dialog}
  aria-label={label}
  class="m-auto h-[min(85dvh,60rem)] w-[min(90vw,80rem)] max-w-none overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/70"
  {onclose}
  onclick={(event) => { if (event.target === dialog) dialog.close(); }}
>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
      <span class="min-w-0 flex-1 truncate text-workspace-chrome">{label}</span>
      <!-- svelte-ignore a11y_autofocus (The modal puts keyboard focus on its close control.) -->
      <button type="button" aria-label="Close media preview" autofocus class="rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onclick={() => dialog.close()}><CloseIcon size={18} /></button>
    </header>
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
</dialog>
