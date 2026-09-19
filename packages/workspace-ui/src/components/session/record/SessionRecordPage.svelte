<script lang="ts">
  import { CloudOff as CloudOffIcon, MessageSquare as MessageSquareIcon, Send as SendIcon } from "@lucide/svelte";
  import type { SessionMeta } from "@solus/contracts/types";
  import { readSessionMeta } from "@solus/client-core/session-meta";
  import { getClientShellContext, getWorkspaceContext, serversStore } from "../../../contexts";
  import type { RouteSurfaceProps } from "../../ui/lib/pane-surface";
  import { paneActions } from "../../ui/lib/pane-actions.svelte";
  import PaneChrome from "../../ui/PaneChrome.svelte";
  import * as Empty from "../../ui/empty";
  import { Skeleton } from "../../ui/skeleton";
  import { Button } from "../../ui/button";
  import { RUNNER_OFFLINE_REASON } from "../lib/session-home";
  import { sessionRecordHeader } from "./lib/session-record-page";

  /**
   * The record of a session whose transcript this client cannot reach: the
   * organization's workspace service keeps the record (docs/plans/cloud-service-model.md
   * §12) while the runner that holds the transcript is offline. The page shows
   * what the record carries and a composer that takes no input, and says why;
   * the transcript mirror is P2.
   */
  let { params, paneId }: RouteSurfaceProps<"sessionRecord"> = $props();

  const session = getWorkspaceContext();
  const shell = getClientShellContext();
  const pane = paneActions(() => paneId);

  let meta = $state<SessionMeta | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(true);

  $effect(() => {
    const { serverId, sessionId } = params;
    let active = true;
    loading = true;
    loadError = null;
    void readSessionMeta(serverId, sessionId).then(
      (loaded) => {
        if (!active) return;
        meta = loaded;
        loading = false;
        if (!loaded) loadError = "The workspace has no record of this session.";
      },
      (error) => {
        if (!active) return;
        loading = false;
        loadError = error instanceof Error ? error.message : String(error);
      },
    );
    return () => {
      active = false;
    };
  });

  const header = $derived(meta ? sessionRecordHeader(meta) : null);
  const home = $derived(serversStore.hostFor(params.serverId));
  const homeLabel = $derived(serversStore.cloudHomeLabel(params.serverId) ?? home?.label ?? "this host");

  function close() {
    session.router.closeGroup("page");
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-(--background) text-workspace-chrome" data-testid="session-record-page">
  <header class="flex h-[2.875rem] shrink-0 items-center gap-2 border-b border-(--hairline) px-4 pointer-coarse:h-14">
    <MessageSquareIcon size={14} class="shrink-0 text-muted-foreground" />
    {#if header}
      <span class="min-w-0 flex-1 truncate font-medium text-(--solus-text-primary)" data-testid="session-record-title">{header.title}</span>
    {:else}
      <Skeleton class="h-3.5 w-40" />
      <span class="flex-1"></span>
    {/if}
    <span class="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-(--solus-container-border) px-2 text-[0.875em] text-(--solus-text-tertiary)" title={RUNNER_OFFLINE_REASON} data-testid="session-record-state">
      <CloudOffIcon size={12} />
      Runner offline
    </span>
  </header>

  <div class="mx-auto flex w-full max-w-(--solus-reading-max) flex-1 flex-col gap-5 overflow-y-auto px-6 pt-8">
    {#if loading}
      <div class="flex flex-col gap-3" role="status" aria-busy="true">
        <Skeleton class="h-3.5 w-1/2" />
        <Skeleton class="h-3 w-full" />
        <Skeleton class="h-3 w-2/3" />
      </div>
    {:else if loadError}
      <Empty.Root class="max-w-[26rem] flex-none border">
        <Empty.Header>
          <Empty.Media variant="icon"><CloudOffIcon /></Empty.Media>
          <Empty.Title>Couldn’t read this session</Empty.Title>
          <Empty.Description>{loadError}</Empty.Description>
        </Empty.Header>
      </Empty.Root>
    {:else if header}
      <p class="font-mono text-[0.875em] text-(--solus-text-tertiary)" data-testid="session-record-meta">{header.meta} · {homeLabel}</p>
      <Empty.Root class="flex-none border">
        <Empty.Header>
          <Empty.Media variant="icon"><CloudOffIcon /></Empty.Media>
          <Empty.Title>{RUNNER_OFFLINE_REASON}</Empty.Title>
          <Empty.Description>
            The transcript is on the machine that ran this session. Connect that machine, or open it there, to read and continue the conversation. The record here stays in step with it.
          </Empty.Description>
        </Empty.Header>
      </Empty.Root>
    {/if}
  </div>

  <!-- The composer, present and inert: the reverse state of a prompt is a bar
       that says why it takes none. -->
  <div class="px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom,0px))]" data-testid="session-record-composer">
    <div class="mx-auto flex max-w-(--solus-reading-max) items-center gap-3 rounded-2xl border border-(--solus-container-border) bg-(--solus-container-bg) px-4 py-3 text-(--solus-text-tertiary)" aria-disabled="true">
      <span class="min-w-0 flex-1 truncate">{RUNNER_OFFLINE_REASON}</span>
      <Button size="icon-sm" variant="ghost" disabled aria-label="Send" title={RUNNER_OFFLINE_REASON}>
        <SendIcon size={14} />
      </Button>
    </div>
  </div>

  {#if shell.canOpenResource("workspace") && paneId}
    <PaneChrome onClose={close} isLeading={pane.isLeading} closeLabel="Close session record" />
  {/if}
</div>
