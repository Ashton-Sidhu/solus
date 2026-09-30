<script lang="ts">
  import {
    getMarkdownImageContext,
    isMarkdownVideo,
    markdownAssetId,
    markdownImagePath,
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

  function expand() {
    expanded = true;
    dialog?.showModal();
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
    <img {src} {title} alt={text} loading="lazy" class="block h-auto max-w-full rounded-lg" />
  </button>
  <!-- A native modal: Escape closes it, focus returns to the button, and it
       sits in the top layer above every pane. Any click closes it. -->
  <dialog
    bind:this={dialog}
    class="m-auto max-h-none max-w-none cursor-zoom-out bg-transparent p-0 outline-none backdrop:bg-black/70"
    aria-label={text || "Image"}
    onclick={() => dialog?.close()}
    onclose={() => (expanded = false)}
  >
    {#if expanded}
      <img {src} alt={text} class="block max-h-[90dvh] max-w-[90vw] rounded-lg object-contain" />
    {/if}
  </dialog>
{:else if src}
  <img {src} {title} alt={text} loading="lazy" class="block h-auto max-w-full" />
{/if}
