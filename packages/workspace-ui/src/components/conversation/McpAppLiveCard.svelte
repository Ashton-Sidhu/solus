<script lang="ts">
  import { untrack } from "svelte";
  import { mcpAppLiveCall, mcpAppLiveFor } from "@solus/client-core/mcp-app-live";
  import { mcpAppsFor, type McpAppRead } from "@solus/client-core/mcp-app-store";
  import type { McpAppCancelReason, McpAppLiveDocument } from "@solus/contracts/mcp-apps";
  import type { Message } from "@solus/contracts/types";
  import { getSurfaceContext, getWorkspaceContext } from "../../contexts";
  import { conversationViewStates } from "./lib/conversation-view-state.svelte";
  import { conversationIsVisible } from "./lib/conversation-visibility";
  import McpAppFrame from "./McpAppFrame.svelte";
  import { Button } from "../ui/button";

  /**
   * The app of a tool call that has not ended (docs/plans/mcp-first-class.md
   * §14.1). It mounts only for a call that runs when the row mounts, and only
   * when the host says the tool has an app for this person. It follows the
   * call, then takes the call's saved app in the same frame. A call that gives
   * no result removes the card, and the plain tool row stays.
   */
  interface Props {
    message: Message;
    /** The Solus tool name `<slug>__<tool>`. */
    toolName: string;
    sessionId: string;
    tabId: string;
    onSend: (text: string) => boolean;
  }

  let { message, toolName, sessionId, tabId, onSend }: Props = $props();

  const surface = getSurfaceContext();
  const workspace = getWorkspaceContext();
  const isVisible = conversationIsVisible();
  const api = $derived(surface.apiForSession(sessionId));
  const mcpApps = $derived(conversationViewStates(workspace).forTab(tabId).mcpApps);
  // Decided once: a row that mounts after its call ended shows the saved card instead.
  const toolUseId = untrack(() => (message.toolStatus === "running" ? message.toolId : undefined));
  const call = $derived(mcpAppLiveCall({ input: message.toolInput, status: message.toolStatus }, workspace.sessionFor(tabId)?.status === "interrupted", isVisible()));
  let liveDocument = $state.raw<McpAppLiveDocument | null>(null);
  let cancelled = $state<McpAppCancelReason | null>(null);
  let activityId = $state<string | null>(null);
  let saved = $state<McpAppRead>({ phase: "idle" });
  const request = $derived({ sessionId, activityId: activityId ?? "" });
  /** The card's view: by its call, until it takes its saved app. */
  const view = $derived(mcpApps.view(activityId ?? toolUseId ?? ""));

  $effect(() => {
    if (!toolUseId) return;
    let isCurrent = true;
    void mcpAppLiveFor(api).document({ sessionId, toolName }).then((document) => {
      if (isCurrent) liveDocument = document;
    });
    return () => {
      isCurrent = false;
    };
  });

  // A card that shows an app holds its call, so the saved card of the call hands it its activity.
  $effect(() => {
    if (!toolUseId || !liveDocument || cancelled) return;
    return mcpAppLiveFor(api).hold(sessionId, toolUseId, (id) => {
      if (activityId) return;
      mcpApps.adopt(toolUseId, id);
      activityId = id;
    });
  });

  $effect(() => {
    if (!activityId) return;
    const store = mcpAppsFor(api);
    const input = { sessionId, activityId };
    const read = () => { saved = store.read(input); };
    const unsubscribe = store.subscribe(input, read);
    read();
    void store.load(input);
    return unsubscribe;
  });
</script>

{#if toolUseId && liveDocument && !cancelled}
  {#if view.isClosed}
    <div class="my-2 flex min-h-11 items-center gap-2 text-workspace-chrome text-muted-foreground">
      <span class="min-w-0 flex-1 truncate">The {liveDocument.title} app was closed</span>
      <Button variant="ghost" size="sm" class="shrink-0 text-workspace-chrome pointer-coarse:min-h-11" onclick={() => view.show()}>Show app</Button>
    </div>
  {:else}
    <McpAppFrame
      snapshot={liveDocument}
      {call}
      savedCall={saved.phase === "ready" ? saved.snapshot : undefined}
      {api}
      {request}
      title={liveDocument.title}
      {onSend}
      onCancel={(reason) => (cancelled = reason)}
      {view}
    />
  {/if}
{/if}
