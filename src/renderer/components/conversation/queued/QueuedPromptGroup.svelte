<script lang="ts">
  import { getWorkspaceContext } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { sendRateLimitedNow } from "../../../lib/rate-limit-actions";
  import { queuedCaption } from "../lib/queued-prompts";
  import UserMessageBubble from "../UserMessageBubble.svelte";
  import type { EnrichedError, OutboundPrompt } from "../../../../shared/types";
  import { liveActivityClock } from "../../../lib/shared-clock";

  interface Props {
    tabId: string;
  }
  let { tabId }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  const prompts = $derived(sess?.outboundPrompts ?? []);
  const isRateLimited = $derived(sess?.status === "rate_limited");
  const resetsAt = $derived(
    sess?.rateLimitInfo?.resetsAt ??
      prompts.find((prompt) => prompt.releaseAt)?.releaseAt,
  );
  // The held prompt carries the window it was queued against, which survives a
  // reconnect that drops rateLimitInfo.
  const rateLimitType = $derived(
    sess?.rateLimitInfo?.rateLimitType ??
      prompts.find((prompt) => prompt.rateLimitType)?.rateLimitType,
  );

  // One timer for the whole queue rather than one per held prompt. It must not
  // read `now`, or every tick would tear down and re-arm its own interval.
  let now = $state(Date.now());
  const hasCountdown = $derived(isRateLimited && !!resetsAt);
  $effect(() => {
    if (!hasCountdown) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  const caption = $derived(
    queuedCaption(prompts, { isRateLimited, resetsAt, rateLimitType, now }),
  );

  function reportError(err: Error) {
    const enriched: EnrichedError = {
      message: err.message,
      stderrTail: [],
      exitCode: null,
      elapsedMs: 0,
      toolCallCount: 0,
    };
    session.handleError(sess!.id, enriched);
  }

  /** The queue's single escape: release everything the limit is holding. */
  async function handleSendNow() {
    await sendRateLimitedNow(
      session.apiFor(tabId),
      session.ctxFor(tabId),
      isRateLimited,
      (err) => session.handleError(sess!.id, err),
    );
    requestInputFocus();
  }

  function handleRemove(prompt: OutboundPrompt) {
    if (!prompt.queueId) return;
    session.apiFor(tabId)
      .cancelQueuedPrompt(session.ctxFor(tabId), prompt.queueId)
      .catch(reportError);
    requestInputFocus();
  }

  function handleEdit(prompt: OutboundPrompt, text: string) {
    if (!prompt.queueId) return;
    session.apiFor(tabId)
      .editQueuedPrompt(session.ctxFor(tabId), prompt.queueId, text)
      .catch(reportError);
    requestInputFocus();
  }
</script>

<!-- §1a — the bubbles are the queue. Each held prompt keeps its place in the
     transcript with a mono ordinal, and one caption under the last one carries
     the count, the cause, the live clock and the escape. The block owns its own
     top margin so the held prompts read as one object, not as n messages. -->
{#if prompts.length > 0}
  <div class="text-xs flex flex-col pt-[0.8125rem] pb-1.5">
    {#each prompts as prompt, index (`outbound-${prompt.clientPromptId}`)}
      <UserMessageBubble
        content={prompt.text}
        attachments={prompt.attachments ??
          prompt.images?.map((img) => ({
            name: "",
            dataUrl: img.dataUrl,
            mimeType: img.mimeType,
            type: "image" as const,
          }))}
        deliveryState={prompt.state}
        ordinal={prompts.length > 1 ? index + 1 : undefined}
        onEditSubmit={prompt.queueId
          ? (text) => handleEdit(prompt, text)
          : undefined}
        onRemove={prompt.queueId ? () => handleRemove(prompt) : undefined}
      />
    {/each}

    {#if caption}
      <div class="mt-px flex items-center justify-end gap-1.5">
        <span
          class="font-medium text-(--muted-foreground) uppercase opacity-70"
        >
          {caption.label}
        </span>
        {#if caption.detail}
          <span class="text-(--muted-foreground) opacity-45">·</span>
          <span class="text-(--muted-foreground)">
            {caption.detail}{#if caption.clock}<span class="text-(--foreground) tabular-nums"
              > · {caption.clock}</span
            >{/if}
          </span>
        {/if}
        {#if caption.canSendNow}
          <span class="text-(--muted-foreground) opacity-45">·</span>
          <button
            type="button"
            onclick={handleSendNow}
            class="cursor-pointer  underline decoration-[color-mix(in_oklch,var(--foreground)_28%,transparent)] underline-offset-[0.15625rem] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium)"
          >
            Send now
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}
