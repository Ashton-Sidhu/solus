<script lang="ts">
  import { mcpAppLiveFor } from "@solus/client-core/mcp-app-live";
  import { mcpAppsFor, type McpAppRead } from "@solus/client-core/mcp-app-store";
  import type { McpAppReference } from "@solus/contracts/mcp-apps";
  import { getSurfaceContext, getWorkspaceContext } from "../../contexts";
  import { nearViewport } from "../../lib/near-viewport";
  import { conversationViewStates } from "./lib/conversation-view-state.svelte";
  import McpAppFrame from "./McpAppFrame.svelte";
  import { Button } from "../ui/button";

  /**
   * An MCP App saved by a tool call. Its body loads once the card is near the
   * viewport; closing it keeps a line to show it again. While the live card
   * of the same call is mounted, that card shows the app and this one is empty.
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
  const isClosed = $derived(viewState.closedMcpApps.has(activityId) || (!!app.toolUseId && viewState.closedMcpApps.has(app.toolUseId)));
  let isNear = $state(false);
  let isHeldLive = $state(false);
  let value = $state<McpAppRead>({ phase: "idle" });

  // The live card of this call takes the activity and keeps its frame.
  $effect(() => {
    const live = mcpAppLiveFor(api);
    const toolUseId = app.toolUseId;
    if (!toolUseId) return;
    const update = () => {
      isHeldLive = live.isHeld(sessionId, toolUseId);
      if (isHeldLive) live.handOver(sessionId, toolUseId, activityId);
    };
    update();
    return live.subscribe(update);
  });

  function show() {
    viewState.closedMcpApps.delete(activityId);
    if (app.toolUseId) viewState.closedMcpApps.delete(app.toolUseId);
  }

  /** Closing an app takes back what it gave the agent, so the agent never acts on an app the person no longer sees. */
  function close() {
    viewState.closedMcpApps.add(activityId);
    if (viewState.mcpAppContexts.delete(activityId)) void api.mcpAppUpdateModelContext({ ...request, text: "" }).catch(() => {});
  }

  $effect(() => {
    // A closed app releases its body so the store can drop it.
    if (isClosed || isHeldLive) {
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
  {#if isHeldLive}
    <!-- The live card above shows this app. -->
  {:else if isClosed}
    <div class="my-2 flex min-h-11 items-center gap-2 text-workspace-chrome text-muted-foreground">
      <span class="min-w-0 flex-1 truncate">The {app.title} app was closed</span>
      <Button variant="ghost" size="sm" class="shrink-0 text-workspace-chrome pointer-coarse:min-h-11" onclick={show}>Show app</Button>
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
      onClose={close}
      modelContext={viewState.mcpAppContexts.get(activityId)}
      onModelContext={(text) => (text ? viewState.mcpAppContexts.set(activityId, text) : viewState.mcpAppContexts.delete(activityId))}
      permissions={viewState.mcpAppPermissions.get(activityId) ?? []}
      onPermissions={(granted) => viewState.mcpAppPermissions.set(activityId, granted)}
      isPip={viewState.isMcpAppPip(activityId)}
      onPip={(turnKey) => (turnKey ? viewState.showMcpAppPip(activityId, turnKey) : viewState.returnMcpAppPip(activityId))}
      pipSide={viewState.mcpAppPipSide}
      onMovePip={() => viewState.moveMcpAppPip()}
    />
  {:else if value.phase === "error"}
    <div class="my-2 flex min-h-28 flex-col items-center justify-center gap-2 text-workspace-chrome text-muted-foreground" role="alert">
      <span>{value.message}</span>
      <Button variant="ghost" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => void store.load(request)}>Try again</Button>
    </div>
  {:else}
    <div class="my-2 flex min-h-28 items-center justify-center text-workspace-chrome text-muted-foreground" role="status">Loading app…</div>
  {/if}
</div>
