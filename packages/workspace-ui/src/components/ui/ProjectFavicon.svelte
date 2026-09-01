<script lang="ts">
  import { Folder as FolderIcon } from "@lucide/svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext } from "../../contexts";
  import { isWorkspaceDir } from "../../lib/paths";
  import { projectFaviconResolver } from "../../lib/project-favicon";
  import WorkspaceMark from "./WorkspaceMark.svelte";

  let {
    projectRoot,
    serverId,
    class: className = "size-3.5",
  }: {
    projectRoot: string;
    serverId?: string | null;
    class?: string;
  } = $props();

  const session = getWorkspaceContext();
  const isWorkspace = $derived(
    isWorkspaceDir(projectRoot, session.staticInfo?.workspacePath),
  );
  const hasRoot = $derived(projectRoot.startsWith("/"));
  const resolvedServerId = $derived.by(() => {
    const contextualServerId =
      serverId ??
      session.sessionFor(session.activeTabId)?.run.serverId ??
      serverConnections.defaultServerId();
    return contextualServerId
      ? serverConnections.resolveId(contextualServerId)
      : "";
  });
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
    if (isWorkspace || !hasRoot || !faviconServerId) {
      source = { key, status: "ready", url: null };
      return;
    }

    source = { key, status: "pending", url: null };
    let cancelled = false;
    void projectFaviconResolver
      .resolve({
        serverId: faviconServerId,
        projectRoot: root,
        origin: serverConnections.httpOriginFor(faviconServerId),
        api: serverConnections.apiFor(faviconServerId),
        ctx: session.ctxForDirectory(root),
      })
      .then((url) => {
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
  {#if isWorkspace}
    <WorkspaceMark class="size-full" />
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
