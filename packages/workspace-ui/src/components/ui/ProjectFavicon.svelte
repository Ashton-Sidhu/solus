<script lang="ts">
  import { untrack } from "svelte";
  import {
    Folder as FolderIcon,
    MessageCircle as ChatIcon,
  } from "@lucide/svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { isChat } from "@solus/contracts/chat";
  import {
    CHATS_GROUP_KEY,
    getSurfaceContext,
    projectsStore,
  } from "../../contexts";
  import { projectFaviconResolver } from "../../lib/project-favicon";

  let {
    projectKey,
    class: className = "size-3.5",
  }: {
    /** The project, as `projectsStore` keys it. Never a bare path: a path
     *  names a folder on one host only. */
    projectKey: string;
    class?: string;
  } = $props();

  const session = getSurfaceContext();
  // A chat has no project, so it has no project icon.
  const inChat = $derived(isChat(projectKey) || projectKey === CHATS_GROUP_KEY);
  // The favicon is a file in one checkout of the project: a host and a folder
  // on it, both from that host's own project list.
  const checkout = $derived(inChat ? null : projectsStore.checkoutFor(projectKey));
  const resolvedServerId = $derived(
    checkout ? serverConnections.resolveId(checkout.serverId) : "",
  );
  const projectRoot = $derived(checkout?.projectRoot ?? "");
  const hasRoot = $derived(projectRoot.startsWith("/"));
  const requestKey = $derived(`${resolvedServerId}\0${projectRoot}`);
  let source = $state<{
    key: string;
    status: "pending" | "ready";
    url: string | null;
  }>({ key: "", status: "pending", url: null });

  $effect(() => {
    const key = requestKey;
    const faviconServerId = resolvedServerId;
    const root = projectRoot;
    if (inChat || !hasRoot || !faviconServerId) {
      source = { key, status: "ready", url: null };
      return;
    }

    source = { key, status: "pending", url: null };
    let cancelled = false;
    const resolution = untrack(() => projectFaviconResolver.resolve({
        serverId: faviconServerId,
        projectRoot: root,
        origin: serverConnections.httpOriginFor(faviconServerId),
        api: serverConnections.apiFor(faviconServerId),
        ctx: session.ctxForDirectory(root),
      }));
    void resolution.then((url) => {
        if (!cancelled) source = { key, status: "ready", url };
      })
      .catch(() => {
        if (!cancelled) source = { key, status: "ready", url: null };
      });
    return () => {
      cancelled = true;
    };
  });
</script>

<span
  class="relative inline-flex flex-shrink-0 items-center justify-center {className}"
>
  {#if inChat}
    <ChatIcon size="100%" class="text-(--solus-text-tertiary)" />
  {:else}
    {#if !hasRoot || (source.key === requestKey && source.status === "ready" && !source.url)}
      <FolderIcon size="100%" class="text-(--solus-text-tertiary)" />
    {:else if source.key === requestKey && source.url}
      <img
        src={source.url}
        alt=""
        aria-hidden="true"
        class="absolute inset-0 size-full rounded-[0.1875rem] object-contain"
        onerror={() => (source = { key: requestKey, status: "ready", url: null })}
      />
    {/if}
  {/if}
</span>
