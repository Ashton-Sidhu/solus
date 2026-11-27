<script lang="ts">
  import { tick } from "svelte";
  import { ArrowUp as SendIcon, ArrowUpRight as OpenIcon } from "@lucide/svelte";
  import type { AppSessionLink, AppSummary } from "@solus/contracts/apps";
  import { getSurfaceContext } from "../../../contexts";
  import { SessionRecordStore } from "../../../contexts/sessions/session-record.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { toasts } from "../../../lib/toasts";
  import RecordTranscript from "../../session/record/RecordTranscript.svelte";
  import { Button } from "../../ui/button";
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";
  import { Skeleton } from "../../ui/skeleton";
  import { Textarea } from "../../ui/textarea";
  import { appSessionByline, appSessionTitle, lastTurnMessages } from "./lib/app-sessions";

  /**
   * One linked session as a conversation (docs/plans/apps.md §9.2): its head,
   * its last turn, and a reply that goes into the session. With no `link`, the
   * card starts a new session for the app: its first prompt is the reply.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Null: the card is a new session that has no prompt yet. */
    link: AppSessionLink | null;
    now: number;
    /** Sends what the person wrote. Rejects with why the send failed. */
    onSend: (prompt: string) => Promise<void>;
    onOpen: () => void;
    onUnlink: () => void;
    /** Leaves a new session without starting it. */
    onCancelNew: () => void;
  }
  let { serverId, app, link, now, onSend, onOpen, onUnlink, onCancelNew }: Props = $props();

  const surface = getSurfaceContext();
  const planFor = (planId: string) => surface.planStore.get(planId);
  const workFor = (workId: string) => surface.worksStore.get(workId);

  // The transcript of the selected session, watched on its host so each turn lands as it happens.
  let record = $state<SessionRecordStore | null>(null);
  // The id alone: a status update gives a new link object, and must not read the transcript again.
  const sessionId = $derived(link?.sessionId ?? null);
  $effect(() => {
    if (!sessionId) {
      record = null;
      return;
    }
    const current = new SessionRecordStore(surface, serverId, sessionId, { watch: true });
    record = current;
    return () => current.dispose();
  });
  const turn = $derived(record?.messages ? lastTurnMessages(record.messages) : null);
  const hasEarlierTurns = $derived(!!record?.messages && !!turn && (record.messages.length > turn.length || record.olderCursor !== null));

  let draft = $state("");
  let isSending = $state(false);
  let composer = $state<HTMLTextAreaElement | null>(null);
  const isNew = $derived(link === null);

  // A new session takes the keyboard: typing its prompt is the next step.
  $effect(() => {
    if (isNew) void tick().then(() => composer?.focus());
  });

  async function send() {
    const prompt = draft.trim();
    if (!prompt || isSending) return;
    isSending = true;
    try {
      await onSend(prompt);
      draft = "";
    } catch (error) {
      toasts.error(isNew ? "The session did not start" : "The reply was not sent", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      isSending = false;
      // Typing again is the next step, in this card.
      await tick();
      composer?.focus();
    }
  }

  function handleComposerKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape" && isNew) {
      event.preventDefault();
      event.stopPropagation();
      onCancelNew();
      requestInputFocus();
    }
  }
</script>

<!-- The one card of the section: the conversation the person works inside. -->
<section
  class="flex min-h-[30rem] min-w-0 flex-1 flex-col rounded-2xl bg-background shadow-[shadow:var(--elev-lift)] dark:bg-card"
  aria-label={link ? appSessionTitle(link) : "New session"}
  data-testid="app-session-card"
>
  <header class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4 pb-1">
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <h3 class="m-0 truncate text-base leading-5 font-semibold text-foreground">{link ? appSessionTitle(link) : "New session"}</h3>
      <p class="m-0 truncate text-[13px] leading-4 text-(--solus-text-tertiary)">
        {link ? appSessionByline(link, now) : `Starts in ${app.project ?? "a new chat folder"} and links to ${app.name}`}
      </p>
    </div>
    {#if link}
      <Button size="sm" variant="ghost" class="text-(--solus-text-tertiary)" onclick={onUnlink} data-testid="app-session-unlink">Unlink</Button>
      <Button size="sm" variant="outline" class="rounded-full" onclick={onOpen} data-testid="app-session-open">
        Open session <OpenIcon />
      </Button>
    {:else}
      <Button size="sm" variant="ghost" class="text-(--solus-text-tertiary)" onclick={onCancelNew}>Cancel</Button>
    {/if}
  </header>

  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-5 text-sm" aria-live="polite">
    {#if !link}
      <p class="m-0 max-w-120 text-pretty text-(--solus-text-secondary)">
        Say what the new session should do for {app.name}. It runs with your default agent and model, and it shows in the list as soon as it starts.
      </p>
    {:else if record?.messages == null}
      {#if record?.transcriptError || record?.error}
        {@const recordError = record.error ?? record.transcriptError}
      <MarkdownAlert alertType="error">
        {#snippet content()}
          <p class="m-0 text-pretty text-foreground" role="alert">{recordError}</p>
        {/snippet}
      </MarkdownAlert>
      {:else}
        <div class="flex flex-col gap-3" aria-busy="true">
          <Skeleton class="ml-auto h-10 w-2/3 rounded-xl" />
          <Skeleton class="h-4 w-4/5" />
          <Skeleton class="h-4 w-3/5" />
        </div>
      {/if}
    {:else if turn && turn.length > 0}
      {#if hasEarlierTurns}
        <button
          type="button"
          class="self-start cursor-pointer border-0 bg-transparent p-0 text-xs text-(--solus-text-tertiary) underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onclick={onOpen}>Earlier turns are in the session</button
        >
      {/if}
      <RecordTranscript messages={turn} {serverId} {planFor} {workFor} openWork={surface.workspace ? (workId) => surface.openWork(workId) : undefined} />
    {:else}
      <p class="m-0 text-(--solus-text-secondary)">This session has no message yet.</p>
    {/if}
  </div>

  <form
    class="px-4.5 pt-3.5 pb-4.5"
    onsubmit={(event) => {
      event.preventDefault();
      void send();
    }}
  >
    <div class="flex min-w-0 items-end gap-2.5 rounded-[14px] bg-background py-1.75 pr-1.75 pl-4 shadow-[shadow:var(--elev-ring)] focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)] dark:bg-card">
      <Textarea
        bind:ref={composer}
        bind:value={draft}
        rows={1}
        class="max-h-40 min-h-8 border-0 px-0 py-1.5 text-sm leading-5! shadow-none placeholder:text-sm! focus-visible:ring-0"
        placeholder={link ? "Reply to this session" : `What should the new session do for ${app.name}?`}
        aria-label={link ? `Reply to ${appSessionTitle(link)}` : "First prompt of the new session"}
        disabled={isSending}
        onkeydown={handleComposerKeydown}
        data-testid="app-session-composer"
      />
      <Button
        type="submit"
        size="icon-sm"
        class="size-8 shrink-0 rounded-[10px]"
        aria-label={link ? "Send the reply" : "Start the session"}
        title={link ? "Send · Enter" : "Start · Enter"}
        disabled={isSending || draft.trim() === ""}
      >
        <SendIcon />
      </Button>
    </div>
  </form>
</section>
