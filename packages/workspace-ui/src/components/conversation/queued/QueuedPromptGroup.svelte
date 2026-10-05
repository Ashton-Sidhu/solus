<script lang="ts">
  import { untrack } from "svelte";
  import { Clock as ClockIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { sendRateLimitedNow } from "../../../lib/rate-limit-actions";
  import { queuedCaption } from "../lib/queued-prompts";
  import QueueEntryEditor from './QueueEntryEditor.svelte';
  import type { SessionQueueMutation } from '@solus/contracts/session-queue';
  import { isSteerableStatus } from '@solus/contracts/types';
  import UserMessageBubble from "../UserMessageBubble.svelte";
  import type { OutboundPrompt } from "@solus/contracts/types";
  import { liveActivityClock } from "../../../lib/shared-clock";
  import { conversationIsVisible } from "../lib/conversation-visibility";

  interface Props {
    tabId: string;
  }
  let { tabId }: Props = $props();

  const session = getWorkspaceContext();
  let editPrompt = $state<OutboundPrompt | null>(null);
  let queueError = $state('');
  const sess = $derived(session.sessionFor(tabId));
  const prompts = $derived(sess?.outboundPrompts ?? []);
  const queued = $derived(prompts.filter((prompt) => !!prompt.queueId));
  $effect(() => { const source = tabId; untrack(() => { void session.queue.refresh(source).catch(reportError); }); });
  const isRateLimited = $derived(sess?.status === "rate_limited");
  // The held prompt carries the window it was queued against, which survives a
  // reconnect that drops rateLimitInfo.
  const rateLimitType = $derived(
    sess?.rateLimitInfo?.rateLimitType ??
      prompts.find((prompt) => prompt.rateLimitType)?.rateLimitType,
  );
  const resetsAt = $derived(
    sess?.rateLimitInfo?.resetsAt ??
      prompts.find((prompt) => prompt.releaseAt)?.releaseAt,
  );

  // One timer for the whole queue rather than one per held prompt. It must not
  // read `now`, or every tick would tear down and re-arm its own interval.
  let now = $state(Date.now());
  const hasCountdown = $derived(isRateLimited && !!resetsAt);
  const onScreen = conversationIsVisible();
  $effect(() => {
    if (!hasCountdown || !onScreen()) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  const caption = $derived(
    queuedCaption(prompts, { isRateLimited, resetsAt, rateLimitType, now }),
  );

  function reportError(err: Error) { queueError = err.message; }

  async function change(mutation: SessionQueueMutation) {
    queueError = '';
    try { await session.queue.change(tabId, mutation); requestInputFocus({ tabId }); }
    catch (error) { reportError(error instanceof Error ? error : new Error(String(error))); void session.queue.refresh(tabId); }
  }

  /** The queue's single escape: release everything the limit is holding. */
  async function handleSendNow() {
    await sendRateLimitedNow(
      session.apiFor(tabId),
      session.ctxFor(tabId),
      isRateLimited,
      (err) => session.eventReducer.handleError(sess!.id, err),
    );
    requestInputFocus();
  }

  function handleRemove(prompt: OutboundPrompt) {
    if (prompt.queueId) void change({ kind: 'remove', queueId: prompt.queueId, revision: prompt.revision ?? 0 });
  }

</script>

<!-- §1a — the bubbles are the queue. Each held prompt keeps its place in the
     transcript with its ordinal, and one caption under the last one carries
     the count, the cause, the live clock and the escape. The block owns its own
     top margin so the held prompts read as one object, not as n messages. -->
{#if prompts.length > 0 || sess?.queueHeld}
  <div class="text-transcript-meta flex flex-col pt-[0.8125rem] pb-1.5">
    {#each prompts as prompt, index (`outbound-${prompt.clientPromptId}`)}
      <UserMessageBubble
        {tabId}
        content={prompt.text}
        attachments={prompt.attachments ??
          prompt.images?.map((img) => ({
            name: "",
            dataUrl: img.dataUrl,
            mimeType: img.mimeType,
            type: "image" as const,
          }))}
        deliveryState={prompt.state}
        author={prompt.author}
        ordinal={prompts.length > 1 ? index + 1 : undefined}
        onRemove={prompt.queueId ? () => handleRemove(prompt) : undefined}
      />
      {#if prompt.queueId}
        <div class="flex flex-wrap items-center justify-end gap-1 text-workspace-chrome">
          <span class="mr-auto text-(--muted-foreground)">{prompt.kind === 'provider_switch' ? 'Provider switch' : prompt.provider ?? ''}{prompt.modelConfig?.modelId ? ` · ${prompt.modelConfig.modelId}` : ''}{prompt.held ? ' · Held' : ''}</span>
          {#if prompt.kind !== 'provider_switch'}
            <button type="button" onclick={() => editPrompt = { ...prompt }} class="rounded px-2 py-1 hover:bg-(--muted) pointer-coarse:min-h-11">Edit</button>
            <button type="button" disabled={prompt.held || !sess || !isSteerableStatus(sess.status)} onclick={() => change({ kind: 'steer', queueId: prompt.queueId!, revision: prompt.revision ?? 0 })} class="rounded px-2 py-1 hover:bg-(--muted) disabled:opacity-40 pointer-coarse:min-h-11">Steer now</button>
          {/if}
          <button type="button" disabled={queued.indexOf(prompt) === 0} onclick={() => change({ kind: 'move', queueId: prompt.queueId!, revision: prompt.revision ?? 0, beforeQueueId: queued[queued.indexOf(prompt) - 1]?.queueId ?? null })} class="rounded px-2 py-1 hover:bg-(--muted) disabled:opacity-40 pointer-coarse:min-h-11" aria-label="Move queued entry up">Up</button>
          <button type="button" disabled={queued.indexOf(prompt) === queued.length - 1} onclick={() => change({ kind: 'move', queueId: prompt.queueId!, revision: prompt.revision ?? 0, beforeQueueId: queued[queued.indexOf(prompt) + 2]?.queueId ?? null })} class="rounded px-2 py-1 hover:bg-(--muted) disabled:opacity-40 pointer-coarse:min-h-11" aria-label="Move queued entry down">Down</button>
        </div>
        {#if prompt.error}<p role="alert" class="text-workspace-chrome text-(--destructive)">{prompt.error}</p>{/if}
      {/if}
    {/each}
    {#if editPrompt}
      {#key editPrompt.queueId}<QueueEntryEditor {tabId} prompt={editPrompt} onClose={() => editPrompt = null} />{/key}
    {/if}
    {#if queueError}<p role="alert" class="text-workspace-chrome text-(--destructive)">{queueError}</p>{/if}
    {#if sess?.queueHeld || prompts.some((prompt) => prompt.held)}
      <button type="button" onclick={() => change({ kind: 'resume' })} class="self-end rounded px-3 py-2 text-workspace-chrome hover:bg-(--muted) pointer-coarse:min-h-11">Resume queue</button>
    {/if}

    {#if caption}
      <div class="mt-px flex items-center justify-end gap-1.5 text-(--muted-foreground)">
        {#if caption.detail}
          <ClockIcon size={12} class="shrink-0 opacity-70" aria-hidden="true" />
        {/if}
        <span class="font-medium">{caption.label}</span>
        {#if caption.detail}
          <span class="opacity-45">·</span>
          <span>
            {caption.detail}{#if caption.clock}{" "}<span class="text-(--foreground) tabular-nums">{caption.clock}</span>{/if}
          </span>
        {/if}
        {#if caption.canSendNow}
          <span class="mx-0.5 h-3 w-px shrink-0 bg-[color-mix(in_oklch,var(--foreground)_14%,transparent)]" aria-hidden="true"></span>
          <button
            type="button"
            onclick={handleSendNow}
            class="cursor-pointer text-(--foreground) underline decoration-[color-mix(in_oklch,var(--foreground)_28%,transparent)] underline-offset-[0.15625rem] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium)"
          >
            Send now
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}
