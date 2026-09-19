<script lang="ts">
  import { tick } from "svelte";
  import { CloudOff as CloudOffIcon, MessageSquare as MessageSquareIcon, ArrowUp as ArrowUpIcon } from "@lucide/svelte";
  import type { Message, SessionMeta } from "@solus/contracts/types";
  import { readSessionMeta } from "@solus/client-core/session-meta";
  import { cloudQueueStore, getClientShellContext, getWorkspaceContext, loadSessionRecordTranscript, serversStore, sharesStore } from "../../../contexts";
  import type { RouteSurfaceProps } from "../../ui/lib/pane-surface";
  import { paneActions } from "../../ui/lib/pane-actions.svelte";
  import PaneChrome from "../../ui/PaneChrome.svelte";
  import * as Empty from "../../ui/empty";
  import { Skeleton } from "../../ui/skeleton";
  import { Button } from "../../ui/button";
  import { Textarea } from "../../ui/textarea";
  import { RUNNER_OFFLINE_NOTE } from "../lib/session-home";
  import { canCancelQueuedPrompt } from "./lib/cloud-queue";
  import { sessionRecordHeader } from "./lib/session-record-page";
  import RecordTranscript from "./RecordTranscript.svelte";
  import CloudQueuedPromptRow from "./CloudQueuedPromptRow.svelte";

  /**
   * A session whose runner is away, read from the organization's workspace
   * service (docs/plans/cloud-service-model.md §12, P2): the record's header,
   * the transcript the cloud mirrors, the prompts waiting on the cloud's
   * durable queue, and a live composer that adds to that queue. The runner
   * picks the queue up when it returns; the chip says so.
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
  let readerUserId = $state<string | null>(null);
  let scrollEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    const { serverId, sessionId } = params;
    let active = true;
    loading = true;
    loadError = null;
    messages = null;
    transcriptError = null;
    void cloudQueueStore.load(serverId, sessionId);
    void sharesStore.identityFor(serverId).then((identity) => {
      if (active) readerUserId = identity.userId;
    }, () => {});
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
  const queue = $derived(cloudQueueStore.queueFor(params.serverId, params.sessionId));
  const queueError = $derived(cloudQueueStore.errorFor(params.serverId, params.sessionId));

  let draft = $state("");
  let sending = $state(false);
  let composerEl = $state<HTMLTextAreaElement | null>(null);
  const canSend = $derived(!sending && draft.trim().length > 0 && !!meta);

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text || sending || !meta) return;
    sending = true;
    const author = { userId: readerUserId ?? "", displayName: null };
    const queued = await cloudQueueStore.enqueue(params.serverId, params.sessionId, text, author);
    sending = false;
    if (queued) draft = "";
    await tick();
    composerEl?.focus();
    scrollEl?.scrollTo({ top: scrollEl.scrollHeight });
  }

  function cancel(queueId: string): void {
    void cloudQueueStore.cancel(params.serverId, params.sessionId, queueId);
    composerEl?.focus();
  }

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
    <span class="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-(--solus-container-border) px-2 text-[0.875em] text-(--solus-text-tertiary)" title={RUNNER_OFFLINE_NOTE} data-testid="session-record-state">
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
        {:else if messages.length === 0 && queue.length === 0}
          <p class="text-(--solus-text-tertiary)" data-testid="session-record-transcript-empty">No transcript yet.</p>
        {:else}
          <RecordTranscript {messages} />
        {/if}

        {#if queue.length > 0}
          <div class="flex flex-col" data-testid="cloud-queue">
            {#each queue as prompt (prompt.queueId)}
              <CloudQueuedPromptRow {prompt} canCancel={canCancelQueuedPrompt(prompt, readerUserId)} onCancel={() => cancel(prompt.queueId)} />
            {/each}
          </div>
        {/if}
        {#if queueError}
          <p class="text-[0.875em] text-destructive" data-testid="cloud-queue-error">Couldn’t read the prompt queue: {queueError}</p>
        {/if}
      {/if}
    </div>
  </div>

  <!-- The composer is live: a prompt lands on the cloud's queue and waits for
       the runner. The note above it says so, in place of a lying spinner. -->
  <div class="px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom,0px))]" data-testid="session-record-composer">
    <p class="mx-auto max-w-(--solus-reading-max) pb-1.5 text-[0.875em] text-(--solus-text-tertiary)" data-testid="session-record-composer-note">{RUNNER_OFFLINE_NOTE}</p>
    <div class="mx-auto flex max-w-(--solus-reading-max) items-end gap-2 rounded-2xl border border-(--solus-container-border) bg-(--solus-container-bg) px-3 py-2">
      <Textarea
        bind:ref={composerEl}
        bind:value={draft}
        class="max-h-40 min-h-0 flex-1 resize-none border-0 bg-transparent px-1 py-1.5 shadow-none focus-visible:ring-0"
        placeholder={meta ? "Send a prompt to wait for the runner…" : "Reading the session…"}
        disabled={!meta || sending}
        submitOn="enter"
        onSubmit={() => void send()}
        aria-label="Prompt"
        data-testid="session-record-composer-input"
      />
      <Button size="icon-sm" variant={canSend ? "default" : "ghost"} disabled={!canSend} onclick={() => void send()} aria-label="Send" title="Send (Enter)" data-testid="session-record-send">
        <ArrowUpIcon size={14} />
      </Button>
    </div>
  </div>

  {#if shell.canOpenResource("workspace") && paneId}
    <PaneChrome onClose={close} isLeading={pane.isLeading} closeLabel="Close session record" />
  {/if}
</div>
