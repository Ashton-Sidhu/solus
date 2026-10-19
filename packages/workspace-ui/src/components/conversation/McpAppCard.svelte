<script lang="ts">
  import { mcpAppsFor, type McpAppRead } from "@solus/client-core/mcp-app-store";
  import type { McpAppReference } from "@solus/contracts/mcp-apps";
  import { getSurfaceContext, getWorkspaceContext } from "../../contexts";
  import { nearViewport } from "../../lib/near-viewport";
  import { conversationViewStates } from "./lib/conversation-view-state.svelte";
  import McpAppFrame from "./McpAppFrame.svelte";

  /**
   * An MCP App saved by a tool call. Its body loads once the card is near the
   * viewport; closing it keeps a line to show it again.
   */
  interface Props {
    activityId: string;
    app: McpAppReference;
    /** The session the app's activity belongs to. */
    sessionId: string;
    tabId: string;
    /** Queues an approved app message in this conversation; false when it could not. */
    onSend: (text: string) => boolean;
  }

  let { activityId, app, sessionId, tabId, onSend }: Props = $props();

  const surface = getSurfaceContext();
  const workspace = getWorkspaceContext();
  const api = $derived(surface.apiForSession(sessionId));
  const store = $derived(mcpAppsFor(api));
  const request = $derived({ sessionId, activityId });
  const viewState = $derived(conversationViewStates(workspace).forTab(tabId));
  const isClosed = $derived(viewState.closedMcpApps.has(activityId));
  let isNear = $state(false);
  let value = $state<McpAppRead>({ phase: "idle" });

  $effect(() => {
    // A closed app releases its body so the store can drop it.
    if (isClosed) {
      value = { phase: "idle" };
      return;
    }
    if (!isNear) return;
    const source = store;
    const input = request;
    const read = () => { value = source.read(input); };
    const unsubscribe = source.subscribe(input, read);
    read();
    void source.load(input);
    return unsubscribe;
  });
</script>

<div use:nearViewport={() => (isNear = true)}>
  {#if isClosed}
    <div class="my-2 flex min-h-11 items-center gap-2 text-workspace-chrome text-muted-foreground">
      <span class="min-w-0 flex-1 truncate">The {app.title} app was closed</span>
      <button type="button" class="min-h-11 px-3 text-foreground hover:opacity-70" onclick={() => viewState.closedMcpApps.delete(activityId)}>Show app</button>
    </div>
  {:else if value.phase === "ready"}
    <McpAppFrame
      snapshot={value.snapshot}
      {api}
      {request}
      title={app.title}
      {onSend}
      initialHeight={viewState.mcpAppHeights.get(activityId)}
      onHeight={(height) => viewState.mcpAppHeights.set(activityId, height)}
      onClose={() => viewState.closedMcpApps.add(activityId)}
    />
  {:else if value.phase === "error"}
    <div class="my-2 flex min-h-28 flex-col items-center justify-center gap-2 text-sm text-muted-foreground" role="alert">
      <span>{value.message}</span>
      <button type="button" class="min-h-11 px-4 text-foreground" onclick={() => void store.load(request)}>Try again</button>
    </div>
  {:else}
    <div class="my-2 flex min-h-28 items-center justify-center text-sm text-muted-foreground" role="status">Loading app…</div>
  {/if}
</div>
