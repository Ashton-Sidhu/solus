<script lang="ts">
  import { tick } from "svelte";
  import {
    getMarkdownImageContext,
    isMarkdownVideo,
    markdownAssetId,
    markdownImagePath,
    zoomScrollOffset,
  } from "./lib/markdown-image";
  import { HostVideoPlayer, VideoPlayer } from "../ui/video-player";
  import { HostMediaUrl, type HostMediaRequest } from "../../lib/host-media-url.svelte";

  interface Props {
    href?: string;
    title?: string;
    text?: string;
    /** A click opens the picture at full size over the workspace. Off where
     *  the surrounding card already owns the click. */
    expandable?: boolean;
  }

  let { href = "", title = undefined, text = "", expandable = false }: Props = $props();
  let dialog = $state<HTMLDialogElement>();
  let expanded = $state(false);
  let zoomed = $state(false);
  /** Only offered where it magnifies: a picture the fitted view did not
   *  shrink is already at its actual size. Measured when it loads fitted. */
  let canZoom = $state(false);

  function measureFit(event: Event) {
    const picture = event.currentTarget as HTMLImageElement;
    canZoom =
      picture.naturalWidth > picture.clientWidth + 1 ||
      picture.naturalHeight > picture.clientHeight + 1;
  }

  function expand() {
    expanded = true;
    dialog?.showModal();
  }

  async function toggleZoom(event: MouseEvent) {
    if (!canZoom) return;
    if (zoomed) {
      zoomed = false;
      return;
    }
    // A click lands where the reader wants to look; Enter or Space opens at
    // the centre.
    const fitted = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const fromPointer = event.detail > 0;
    const fractionX = fromPointer ? (event.clientX - fitted.left) / fitted.width : 0.5;
    const fractionY = fromPointer ? (event.clientY - fitted.top) / fitted.height : 0.5;
    zoomed = true;
    await tick();
    if (!dialog) return;
    const viewer = dialog.getBoundingClientRect();
    const pointerX = fromPointer ? event.clientX - viewer.left : viewer.width / 2;
    const pointerY = fromPointer ? event.clientY - viewer.top : viewer.height / 2;
    dialog.scrollLeft = zoomScrollOffset(fractionX, dialog.scrollWidth, pointerX);
    dialog.scrollTop = zoomScrollOffset(fractionY, dialog.scrollHeight, pointerY);
  }

  /** The backdrop closes the viewer. Tested by position, not target: the
   *  dialog's own scrollbars report the dialog as their target too. */
  function closeOnBackdrop(event: MouseEvent) {
    if (!dialog) return;
    const viewer = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= viewer.left &&
      event.clientX <= viewer.right &&
      event.clientY >= viewer.top &&
      event.clientY <= viewer.bottom;
    if (!inside) dialog.close();
  }
  const context = getMarkdownImageContext();
  const assetId = $derived(markdownAssetId(href));
  const path = $derived(markdownImagePath(href, context?.cwd()));
  // `![caption](/abs/path.mp4)` in an agent reply plays in place.
  const isVideo = $derived(isMarkdownVideo(href, path, assetId));
  // A host file or stored asset loads from a signed URL; anything else is a
  // plain web URL the browser loads as written.
  const hostRequest = $derived.by((): HostMediaRequest | null => {
    const serverId = context?.serverId();
    if (!serverId || (!path && !assetId)) return null;
    return {
      serverId,
      path: path ?? undefined,
      assetId: assetId ?? undefined,
      ctx: context?.ctx(),
    };
  });
  const image = new HostMediaUrl(() => (isVideo ? null : hostRequest));
  // A host that cannot sign the file still gets the reference as written.
  const src = $derived(!hostRequest || image.hasFailed ? href : image.url);
</script>

{#if isVideo}
  <!-- Keyed on the reference: a different video is a new player, while a
       renewed URL for the same one keeps its playhead. -->
  {#key href}
    {#if hostRequest}
      <HostVideoPlayer request={hostRequest} label={text || title || ""} class="my-2 max-w-[40rem]" />
    {:else}
      <VideoPlayer src={href} label={text || title || ""} class="my-2 max-w-[40rem]" />
    {/if}
  {/key}
{:else if src && expandable}
  <button
    type="button"
    class="block max-w-full cursor-zoom-in rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    aria-label={text ? `Expand image: ${text}` : "Expand image"}
    onclick={expand}
  >
    <img
      {src}
      {title}
      alt={text}
      loading="lazy"
      class="block h-auto max-h-[30rem] max-w-[min(100%,30rem)] rounded-lg border border-border/40"
    />
  </button>
  <!-- A native modal: Escape closes it, focus returns to the button, and it
       sits in the top layer above every pane. A click on the picture switches
       between fit and actual size; at actual size the viewer scrolls. A click
       on the backdrop closes it. -->
  <dialog
    bind:this={dialog}
    class="scrollbar-on-hover m-auto max-h-[90dvh] max-w-[90vw] overflow-auto rounded-lg bg-transparent p-0 outline-none backdrop:bg-black/70"
    aria-label={text || "Image"}
    onclick={closeOnBackdrop}
    onclose={() => {
      expanded = false;
      zoomed = false;
      canZoom = false;
    }}
  >
    {#if expanded}
      <button
        type="button"
        class="block outline-none {zoomed
          ? 'cursor-zoom-out'
          : canZoom
            ? 'cursor-zoom-in'
            : 'cursor-default'}"
        aria-label={zoomed ? "Fit image to the window" : "Zoom image to actual size"}
        aria-pressed={zoomed}
        onclick={toggleZoom}
      >
        <img
          {src}
          alt={text}
          onload={measureFit}
          class="block {zoomed
            ? 'max-h-none max-w-none'
            : 'max-h-[90dvh] max-w-[90vw] object-contain'}"
        />
      </button>
    {/if}
  </dialog>
{:else if src}
  <img {src} {title} alt={text} loading="lazy" class="block h-auto max-w-full" />
{/if}
