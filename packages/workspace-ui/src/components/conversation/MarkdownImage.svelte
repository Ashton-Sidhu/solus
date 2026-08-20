<script lang="ts">
  import {
    hostCapabilitiesStore,
  } from "../../contexts";
  import {
    getMarkdownImageContext,
    markdownAssetId,
    markdownImagePath,
  } from "./lib/markdown-image";
  import { hostPolicy } from "@solus/client-core/host-policy";
  import { serverConnections } from "@solus/client-core/server-connections";
  import {
    assetUrlCache,
    localArtifactProtocolUrl,
  } from "../artifact/lib/asset-url";

  interface Props {
    href?: string;
    title?: string;
    text?: string;
  }

  let { href = "", title = undefined, text = "" }: Props = $props();
  const context = getMarkdownImageContext();
  let src = $state("");
  $effect(() => {
    const assetId = markdownAssetId(href);
    const path = markdownImagePath(href, context?.cwd());
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

{#if src}
  <img {src} {title} alt={text} loading="lazy" class="block h-auto max-w-full" />
{/if}
