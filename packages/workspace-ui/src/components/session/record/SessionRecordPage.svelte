<script lang="ts">
  import { tick } from "svelte";
  import { CloudOff as CloudOffIcon, MessageSquare as MessageSquareIcon, Send as SendIcon } from "@lucide/svelte";
  import type { Message, SessionMeta } from "@solus/contracts/types";
  import { readSessionMeta } from "@solus/client-core/session-meta";
  import { getClientShellContext, getWorkspaceContext, loadSessionRecordTranscript, serversStore } from "../../../contexts";
  import type { RouteSurfaceProps } from "../../ui/lib/pane-surface";
  import { paneActions } from "../../ui/lib/pane-actions.svelte";
  import PaneChrome from "../../ui/PaneChrome.svelte";
  import * as Empty from "../../ui/empty";
  import { Skeleton } from "../../ui/skeleton";
  import { Button } from "../../ui/button";
  import { RUNNER_OFFLINE_REASON } from "../lib/session-home";
  import { sessionRecordHeader } from "./lib/session-record-page";
  import RecordTranscript from "./RecordTranscript.svelte";

  /**
   * A session whose runner is away, read from the organization's workspace
   * service (docs/plans/cloud-service-model.md §12, §18): the record's header
   * and the transcript the cloud mirrors. The composer is present and inert:
   * a prompt goes to the runner that holds the session, so it can be sent
   * once that runner is back. The chip and the composer say so.
   */
  let { params, paneId }: RouteSurfaceProps<"sessionRecord"> = $props();

  const workspace = getWorkspaceContext();
  const shell = getClientShellContext();
  const pane = paneActions(() => paneId);

  let meta = $state<SessionMeta | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(true);
  let messages = $state<Message[] | null>(null);
  let transcriptError = $state<string | null>(null);
  let scrollEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    const { serverId, sessionId } = params;
    let active = true;
    loading = true;
    loadError = null;
    messages = null;
    transcriptError = null;
    void readSessionMeta(serverId, sessionId).then(
      async (loaded) => {
        if (!active) return;
        meta = loaded;
        loading = false;
        if (!loaded) {
          loadError = "The workspace has no record of this session.";
          return;
        }
        try {
          const transcript = await loadSessionRecordTranscript(workspace, serverId, loaded);
          if (!active) return;
          messages = transcript;
          await tick();
          scrollEl?.scrollTo({ top: scrollEl.scrollHeight });
        } catch (error) {
          if (!active) return;
          transcriptError = error instanceof Error ? error.message : String(error);
        }
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
    workspace.router.closeGroup("page");
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

  <div bind:this={scrollEl} class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex w-full max-w-(--solus-reading-max) flex-col gap-4 px-6 pt-8 pb-4">
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

        {#if transcriptError}
          <Empty.Root class="max-w-[26rem] flex-none border" data-testid="session-record-transcript-error">
            <Empty.Header>
              <Empty.Media variant="icon"><CloudOffIcon /></Empty.Media>
              <Empty.Title>Couldn’t read the transcript</Empty.Title>
              <Empty.Description>{transcriptError}</Empty.Description>
            </Empty.Header>
          </Empty.Root>
        {:else if messages === null}
          <div class="flex flex-col gap-3" role="status" aria-busy="true" data-testid="session-record-transcript-loading">
            <Skeleton class="h-3 w-3/4" />
            <Skeleton class="h-3 w-full" />
            <Skeleton class="h-3 w-1/2" />
          </div>
        {:else if messages.length === 0}
          <p class="text-(--solus-text-tertiary)" data-testid="session-record-transcript-empty">No transcript yet.</p>
        {:else}
          <RecordTranscript {messages} />
        {/if}
      {/if}
    </div>
  </div>

  <!-- The composer, present and inert: the reverse state of a prompt is a bar
       that says why it takes none, and when it will again. -->
  <div class="px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom,0px))]" data-testid="session-record-composer">
    <p class="mx-auto max-w-(--solus-reading-max) pb-1.5 text-[0.875em] text-(--solus-text-tertiary)" data-testid="session-record-composer-note">A prompt can be sent once the runner is back.</p>
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
