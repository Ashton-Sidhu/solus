<script lang="ts">
  import { fade } from "svelte/transition";
  import { X as CloseIcon } from "@lucide/svelte";
  import type { CommentPin, PlanComment } from "@solus/contracts/types";
  import CommentThreadCard from "../comments/CommentThreadCard.svelte";
  import { CommentComposer } from "../ui/comment-composer";
  import PresenceAvatar from "../presence/PresenceAvatar.svelte";
  import { presenceTint } from "../presence/lib/presence-people";
  import { getCommentViewer } from "../comments/lib/comment-viewer";
  import { authorLabel, commentAuthor, isResolved, isUnread, messagePerson } from "../comments/lib/thread";
  import { threadTime } from "../../lib/relative-time";
  import {
    cardWidthFor,
    nextPinLabel,
    pinFromPointer,
    pinnedThreads,
    placeCommentCard,
    placePins,
    PIN_SIZE,
    type PinTone,
  } from "./lib/artifact-comments";

  /**
   * The comment surface over an artifact's render (docs/plans/multiplayer-comments.md
   * §4): the pins, the composer where a new pin was dropped, the one open
   * thread's card, and the list of every thread. The layer lets pointer events
   * through to the render until the pin tool is armed; then it takes the next
   * click as a pin. The shell owns every piece of overlay state, so its Escape
   * binding can close whatever is up.
   */
  interface Props {
    comments: PlanComment[];
    /** A viewer on the share list: threads to read, no composer. */
    readOnly: boolean;
    /** The pin tool is armed: the next click on the render drops a pin. */
    armed: boolean;
    /** A pin dropped and not yet written. */
    draftPin: CommentPin | null;
    openThreadId: string | null;
    listOpen: boolean;
    now: number;
    onAdd: (pin: CommentPin, label: string, text: string) => void;
    onEdit: (commentId: string, text: string) => void;
    onDelete: (commentId: string) => void;
    onReply: (commentId: string, text: string) => void;
    onResolve: (commentId: string, resolved: boolean) => void;
    onRead: (commentId: string) => void;
  }

  let {
    comments,
    readOnly,
    armed = $bindable(false),
    draftPin = $bindable(null),
    openThreadId = $bindable(null),
    listOpen = $bindable(false),
    now,
    onAdd,
    onEdit,
    onDelete,
    onReply,
    onResolve,
    onRead,
  }: Props = $props();

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let layerEl = $state<HTMLDivElement | null>(null);
  let width = $state(0);
  let height = $state(0);
  const box = $derived({ width, height });

  const viewer = getCommentViewer();
  const self = $derived(viewer().selfUserIds);

  let showResolved = $state(false);
  const pins = $derived(placePins(comments, box, showResolved));
  const openThread = $derived(openThreadId === null ? null : (comments.find((c) => c.id === openThreadId) ?? null));
  const cardWidth = $derived(cardWidthFor(box));
  const draftLabel = $derived(nextPinLabel(comments));

  // Measured, not guessed: the card is as tall as its conversation, and the
  // clamp needs the real number to keep the reply box on screen.
  let cardHeight = $state(180);
  let composerHeight = $state(132);
  const cardPlacement = $derived(openThread ? placeCommentCard(openThread, cardHeight, box) : null);
  const composerPlacement = $derived(draftPin ? placeCommentCard({ pin: draftPin }, composerHeight, box) : null);

  let editingThreadId = $state<string | null>(null);

  const openList = $derived(comments.filter((c) => !isResolved(c)));
  const resolvedList = $derived(comments.filter(isResolved));

  function handleLayerClick(event: MouseEvent) {
    if (!armed || readOnly || !layerEl) return;
    if (event.target instanceof Element && event.target.closest("[data-artifact-pin], [data-artifact-card]")) return;
    draftPin = pinFromPointer(event.clientX, event.clientY, layerEl.getBoundingClientRect());
    openThreadId = null;
    listOpen = false;
    armed = false;
  }

  function openThreadCard(commentId: string) {
    draftPin = null;
    editingThreadId = null;
    listOpen = false;
    openThreadId = commentId;
    onRead(commentId);
  }

  function closeCard() {
    openThreadId = null;
    editingThreadId = null;
  }

  /** The number a thread's pin shows, or none for a note on the whole render. */
  function pinNumber(comment: PlanComment): number | null {
    const index = pinnedThreads(comments).indexOf(comment);
    return index === -1 ? null : index + 1;
  }

  /** A pin wears its author's colour, so the dots on a render are the same
   *  faces as the stack in the band; an agent's is the accent, a settled one sage. */
  function pinColor(comment: PlanComment, tone: PinTone): string {
    if (tone === "resolved") return "var(--solus-art-3)";
    if (tone === "agent" || !comment.person) return "var(--solus-accent)";
    return presenceTint(comment.person.colorIndex).color;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={layerEl}
  bind:clientWidth={width}
  bind:clientHeight={height}
  class="absolute inset-0 {armed ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'}"
  data-testid="artifact-comment-layer"
  data-armed={armed || undefined}
  onclick={handleLayerClick}
>
  {#each pins as pin (pin.comment.id)}
    <!-- The dot rides its fraction of the render, so it lands on the same spot
         at every pane width the render reflows to. -->
    <button
      type="button"
      data-artifact-pin
      class="pointer-events-auto absolute flex items-center justify-center rounded-full border-2 border-(--background) text-[11px] font-semibold leading-none text-white shadow-[0_2px_8px_rgba(0,0,0,0.25)] transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent) pointer-coarse:text-xs"
      class:opacity-60={pin.tone === "resolved"}
      style="left:{pin.left - PIN_SIZE / 2}px;top:{pin.top - PIN_SIZE / 2}px;width:{PIN_SIZE}px;height:{PIN_SIZE}px;background:{pinColor(pin.comment, pin.tone)}"
      aria-label="Open thread {pin.number}: {pin.comment.comment}"
      title={pin.comment.comment}
      data-unread={isUnread(pin.comment, self) || undefined}
      onclick={() => (openThreadId === pin.comment.id ? closeCard() : openThreadCard(pin.comment.id))}
    >
      {pin.number}
    </button>
  {/each}

  {#if draftPin && composerPlacement}
    <!-- Starts the thread where it will live: the composer takes the card's
         place exactly, so posting swaps one floating card for another. -->
    <div
      data-artifact-card
      class="pointer-events-auto absolute z-[8] flex flex-col gap-1.5 drop-shadow-[0_1rem_2.375rem_rgba(60,40,25,0.42)]"
      style="left:{composerPlacement.left}px;top:{composerPlacement.top}px;width:{cardWidth}px"
      bind:clientHeight={composerHeight}
      transition:fade|global={{ duration: reduceMotion ? 0 : 120 }}
    >
      <span
        class="absolute rounded-full border-2 border-(--background) bg-(--solus-accent)"
        style="left:{(draftPin.x * width) - composerPlacement.left - PIN_SIZE / 2}px;top:{(draftPin.y * height) - composerPlacement.top - PIN_SIZE / 2}px;width:{PIN_SIZE}px;height:{PIN_SIZE}px"
        aria-hidden="true"
      ></span>
      <CommentComposer
        anchorLabel={draftLabel}
        onSave={(text) => {
          const pin = draftPin;
          if (pin) onAdd(pin, draftLabel, text);
          draftPin = null;
        }}
        onCancel={() => (draftPin = null)}
        placeholder="Comment on the render…"
        submitOn="enter"
      />
    </div>
  {/if}

  {#if openThread && cardPlacement}
    <div
      data-artifact-card
      class="pointer-events-auto absolute z-[8] flex flex-col gap-1.5 drop-shadow-[0_1rem_2.375rem_rgba(60,40,25,0.42)]"
      style="left:{cardPlacement.left}px;top:{cardPlacement.top}px;width:{cardWidth}px"
      bind:clientHeight={cardHeight}
      transition:fade|global={{ duration: reduceMotion ? 0 : 120 }}
      data-testid="artifact-thread-card"
    >
      <!-- The card always says what it is on. A render cannot be clicked to
           dismiss it — the frame keeps the click — so the chip carries the way out. -->
      <div class="flex max-w-full items-center gap-1.5 self-start rounded-md border border-(--solus-container-border) bg-(--solus-container-bg) px-[0.4375rem] py-0.5 text-xs text-(--solus-text-tertiary)">
        <span class="truncate">{pinNumber(openThread) === null ? "Whole render" : openThread.selectedText}</span>
        <button
          type="button"
          class="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
          aria-label="Close thread"
          onclick={closeCard}
        >
          <CloseIcon size={12} />
        </button>
      </div>
      <CommentThreadCard
        comment={openThread}
        focused
        {now}
        editing={editingThreadId === openThread.id}
        onFocus={() => {}}
        onResolve={(resolved) => {
          onResolve(openThread.id, resolved);
          if (resolved) closeCard();
        }}
        onReply={(text) => onReply(openThread.id, text)}
        onStartEdit={() => (editingThreadId = openThread.id)}
        onSaveEdit={(text) => {
          onEdit(openThread.id, text);
          editingThreadId = null;
        }}
        onCancelEdit={() => (editingThreadId = null)}
        onDelete={() => {
          onDelete(openThread.id);
          closeCard();
        }}
      />
    </div>
  {/if}

  {#if listOpen}
    <!-- Every thread on the render, pinned or not: an agent's whole-render note
         has no dot to click, and this is where it is found. -->
    <div
      data-artifact-card
      class="pointer-events-auto absolute top-3 right-3 z-[9] flex max-h-[calc(100%-1.5rem)] w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-(--solus-container-border) bg-(--solus-popover-bg) shadow-[var(--solus-popover-shadow)]"
      data-testid="artifact-thread-list"
      transition:fade|global={{ duration: reduceMotion ? 0 : 120 }}
    >
      <div class="flex items-center gap-2 border-b border-(--solus-container-border) px-3 py-2">
        <span class="text-xs font-medium text-(--solus-text-primary)">Comments</span>
        <span class="text-xs text-(--solus-text-tertiary)">{openList.length} open</span>
        <button
          type="button"
          class="ml-auto flex size-6 items-center justify-center rounded text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) pointer-coarse:size-10"
          aria-label="Close comments"
          onclick={() => (listOpen = false)}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
        {#if comments.length === 0}
          <p class="px-2 py-3 text-xs text-(--solus-text-tertiary)">
            {readOnly ? "No comments on this render yet." : "No comments yet. Arm the pin tool and click the render to leave one."}
          </p>
        {/if}
        {#each openList as thread (thread.id)}
          {@const person = messagePerson(thread, self)}
          {@const number = pinNumber(thread)}
          <button
            type="button"
            class="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:outline-(--solus-accent-border)"
            class:bg-(--solus-accent-soft)={openThreadId === thread.id}
            onclick={() => openThreadCard(thread.id)}
          >
            <span class="flex items-center gap-1.5 text-xs text-(--solus-text-tertiary)">
              {#if isUnread(thread, self)}
                <span class="size-1.5 rounded-full bg-(--solus-accent)" aria-label="Unread"></span>
              {/if}
              <span class="font-mono">{number === null ? "Whole render" : `Pin ${number}`}</span>
              {#if commentAuthor(thread) === "solus"}
                <span class="text-(--solus-accent)">✦ {authorLabel(thread, self)}</span>
              {:else if person}
                <PresenceAvatar {person} size={14} />
                <span class="truncate">{person.displayName}</span>
              {/if}
              {#if thread.createdAt}
                <span class="ml-auto tabular-nums">{threadTime(thread.createdAt, now)}</span>
              {/if}
            </span>
            <span class="line-clamp-2 text-xs text-(--solus-text-primary)">{thread.comment}</span>
          </button>
        {/each}
        {#if resolvedList.length > 0}
          <div class="mt-1 flex items-center gap-2 border-t border-(--solus-container-border) px-2 pt-2 text-xs text-(--solus-text-tertiary)">
            <span class="size-1.5 rounded-full bg-(--solus-art-3)" aria-hidden="true"></span>
            <span>{resolvedList.length} resolved</span>
            <button type="button" class="ml-auto hover:text-(--solus-text-primary)" onclick={() => (showResolved = !showResolved)}>
              {showResolved ? "Hide pins" : "Show pins"}
            </button>
          </div>
          {#each resolvedList as thread (thread.id)}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover)"
              onclick={() => openThreadCard(thread.id)}
            >
              <span class="font-mono">{pinNumber(thread) === null ? "Whole render" : `Pin ${pinNumber(thread)}`}</span>
              <span class="truncate">{thread.comment}</span>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>
