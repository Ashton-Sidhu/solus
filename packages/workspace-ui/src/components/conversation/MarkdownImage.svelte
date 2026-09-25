<script lang="ts">
  import {
    hostCapabilitiesStore,
  } from "../../contexts";
  import {
    getMarkdownImageContext,
    isMarkdownVideo,
    markdownAssetId,
    markdownImagePath,
  } from "./lib/markdown-image";
  import { hostPolicy } from "@solus/client-core/host-policy";
  import { serverConnections } from "@solus/client-core/server-connections";
  import {
    assetUrlCache,
    localArtifactProtocolUrl,
  } from "../artifact/lib/asset-url";
  import { HostVideoPlayer, VideoPlayer } from "../ui/video-player";
  import type { HostMediaRequest } from "../../lib/host-media-url.svelte";

  interface Props {
    href?: string;
    title?: string;
    text?: string;
  }

  let { href = "", title = undefined, text = "" }: Props = $props();
  const context = getMarkdownImageContext();
  const assetId = $derived(markdownAssetId(href));
  const path = $derived(markdownImagePath(href, context?.cwd()));
  // `![caption](/abs/path.mp4)` in an agent reply plays in place.
  const isVideo = $derived(isMarkdownVideo(href, path, assetId));
  const videoRequest = $derived.by((): HostMediaRequest | null => {
    const serverId = context?.serverId();
    if (!isVideo || !serverId || (!path && !assetId)) return null;
    return {
      serverId,
      path: path ?? undefined,
      assetId: assetId ?? undefined,
      ctx: context?.ctx(),
      canReadLocalFiles: !context?.isWeb(),
    };
  });
  let src = $state("");
  $effect(() => {
    if (isVideo) return;
    const serverId = context?.serverId();
    if ((!path && !assetId) || !serverId) {
      src = href;
      return;
    }
    if (path && !context?.isWeb() && hostPolicy.isClientMachine(serverId)) {
      src = localArtifactProtocolUrl(path);
      return;
    }
    const capabilities = hostCapabilitiesStore.for(serverId);
    if (capabilities === undefined) {
      src = "";
      void hostCapabilitiesStore.load(serverId);
      return;
    }
    if (capabilities.assetUrls !== true) {
      src = href;
      return;
    }
    const ctx = context?.ctx();
    if (!ctx && !assetId) {
      src = href;
      return;
    }

    let cancelled = false;
    src = "";
    void assetUrlCache
      .resolve({
        serverId,
        path: path ?? undefined,
        assetId: assetId ?? undefined,
        origin: serverConnections.httpOriginFor(serverId),
        api: serverConnections.apiFor(serverId),
        ctx,
      })
      .then((url) => {
        if (!cancelled) src = url;
      })
      .catch(() => {
        if (!cancelled) src = href;
      });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if isVideo}
  <!-- Keyed on the reference: a different video is a new player, while a
       renewed URL for the same one keeps its playhead. -->
  {#key href}
    {#if videoRequest}
      <HostVideoPlayer request={videoRequest} label={text || title || ""} class="my-2 max-w-[40rem]" />
    {:else}
      <VideoPlayer src={href} label={text || title || ""} class="my-2 max-w-[40rem]" />
    {/if}
  {/key}
{:else if src}
  <img {src} {title} alt={text} loading="lazy" class="block h-auto max-w-full" />
{/if}
