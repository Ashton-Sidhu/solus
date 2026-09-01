<script lang="ts">
  import {
    hostCapabilitiesStore,
  } from "../../contexts";
  import {
    getMarkdownImageContext,
    markdownImagePath,
  } from "./lib/markdown-image";
  import { hostPolicy } from "@client-core/host-policy";
  import { serverConnections } from "@client-core/server-connections";
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
    const path = markdownImagePath(href, context?.cwd());
    const serverId = context?.serverId();
    if (!path || !serverId) {
      src = href;
      return;
    }
    if (!context?.isWeb() && hostPolicy.isClientMachine(serverId)) {
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
    if (!ctx) {
      src = href;
      return;
    }

    let cancelled = false;
    src = "";
    void assetUrlCache
      .resolve({
        serverId,
        path,
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
