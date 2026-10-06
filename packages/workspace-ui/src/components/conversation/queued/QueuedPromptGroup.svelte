<script lang="ts">
  import { untrack } from "svelte";
  import { ArrowDown as ArrowDownIcon, ArrowUp as ArrowUpIcon, Clock as ClockIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { sendRateLimitedNow } from "../../../lib/rate-limit-actions";
  import { queuedCaption, queuedEntryModel } from "../lib/queued-prompts";
  import ProviderMark from "../../ui/ProviderMark.svelte";
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

  /** Moves a queued entry one place; `beforeQueueId: null` puts it last. */
  function move(prompt: OutboundPrompt, by: -1 | 1) {
    const index = queued.indexOf(prompt);
    const before = by < 0 ? queued[index - 1] : queued[index + 2];
    void change({ kind: 'move', queueId: prompt.queueId!, revision: prompt.revision ?? 0, beforeQueueId: before?.queueId ?? null });
  }

</script>

{#snippet moveButtons(prompt: OutboundPrompt, queueIndex: number)}
  <button type="button" disabled={queueIndex <= 0} onclick={() => move(prompt, -1)} class="flex cursor-pointer items-center text-transcript-meta text-(--solus-text-tertiary) transition-colors duration-100 hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:text-(--solus-text-tertiary) pointer-coarse:min-h-11" aria-label="Move queued entry up" title="Move up"><ArrowUpIcon size={13} /></button>
  <button type="button" disabled={queueIndex === queued.length - 1} onclick={() => move(prompt, 1)} class="flex cursor-pointer items-center text-transcript-meta text-(--solus-text-tertiary) transition-colors duration-100 hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:text-(--solus-text-tertiary) pointer-coarse:min-h-11" aria-label="Move queued entry down" title="Move down"><ArrowDownIcon size={13} /></button>
{/snippet}

<!-- §1a — the bubbles are the queue. Each held prompt keeps its place in the
     transcript with its ordinal, and one caption under the last one carries
     the count, the cause, the live clock and the escape. The block owns its own
     top margin so the held prompts read as one object, not as n messages. -->
{#if prompts.length > 0 || sess?.queueHeld}
  <div class="text-transcript-meta flex flex-col pt-[0.8125rem] pb-1.5">
    {#each prompts as prompt, index (`outbound-${prompt.clientPromptId}`)}
      {@const model = queuedEntryModel(prompt)}
      {@const queueIndex = queued.indexOf(prompt)}
      {#if editPrompt && editPrompt.queueId === prompt.queueId}
        {#key editPrompt.queueId}<QueueEntryEditor {tabId} prompt={editPrompt} onClose={() => editPrompt = null} />{/key}
      {:else if prompt.kind === 'provider_switch'}
        <!-- A switch is not a message: one quiet line at its place in the queue. -->
        <div class="flex items-center justify-end gap-2.5 py-1.5 text-(--solus-text-tertiary)">
          <span class="flex min-w-0 items-center gap-1.5">
            <ProviderMark mark={model?.mark ?? null} size={12} />
            <span class="truncate">Switch to {model?.label ?? 'another model'}</span>
            {#if prompt.held}<span class="opacity-45">·</span><span>Held</span>{/if}
          </span>
          {@render moveButtons(prompt, queueIndex)}
          <button type="button" onclick={() => handleRemove(prompt)} class="cursor-pointer opacity-60 transition-[color,opacity] duration-100 hover:text-(--destructive) hover:opacity-100 focus-visible:text-(--destructive) focus-visible:opacity-100 focus-visible:outline-none pointer-coarse:min-h-11">Remove</button>
        </div>
      {:else}
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
          actions={prompt.queueId ? queueActions : undefined}
        />
        {#snippet queueActions()}
          <button type="button" onclick={() => editPrompt = { ...prompt }} class="flex cursor-pointer items-center text-transcript-meta text-(--solus-text-tertiary) transition-colors duration-100 hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:text-(--solus-text-tertiary) pointer-coarse:min-h-11">Edit</button>
          <button type="button" disabled={prompt.held || !sess || !isSteerableStatus(sess.status)} onclick={() => change({ kind: 'steer', queueId: prompt.queueId!, revision: prompt.revision ?? 0 })} class="flex cursor-pointer items-center text-transcript-meta text-(--solus-text-tertiary) transition-colors duration-100 hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:text-(--solus-text-tertiary) pointer-coarse:min-h-11">Steer now</button>
          {@render moveButtons(prompt, queueIndex)}
        {/snippet}
        {#if prompt.queueId && (model || prompt.held)}
          <!-- The model this prompt runs with, named and marked as the picker shows it. -->
          <div class="mt-1 flex items-center justify-end gap-1.5 text-(--solus-text-tertiary)">
            {#if model}
              <ProviderMark mark={model.mark} size={11} />
              <span class="truncate">{model.label}</span>
            {/if}
            {#if prompt.held}{#if model}<span class="opacity-45">·</span>{/if}<span>Held</span>{/if}
          </div>
        {/if}
      {/if}
      {#if prompt.error}<p role="alert" class="mt-1 text-right text-(--destructive)">{prompt.error}</p>{/if}
    {/each}
    {#if queueError}<p role="alert" class="mt-1 text-right text-(--destructive)">{queueError}</p>{/if}
    {#if sess?.queueHeld || prompts.some((prompt) => prompt.held)}
      <button type="button" onclick={() => change({ kind: 'resume' })} class="mt-1.5 cursor-pointer self-end font-medium text-(--foreground) underline decoration-[color-mix(in_oklch,var(--foreground)_28%,transparent)] underline-offset-[0.15625rem] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:min-h-11">Resume queue</button>
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
