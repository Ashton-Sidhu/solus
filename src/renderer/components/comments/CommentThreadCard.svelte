<script lang="ts">
  import type { PlanComment } from '../../../shared/types'
  import { threadTime } from '../../lib/relative-time'
  import PlanCommentEditor from '../plan/PlanCommentEditor.svelte'
  import CommentBody from './CommentBody.svelte'
  import {
    authorInitials,
    authorLabel,
    authorName,
    commentAuthor,
    isResolved,
    isUnread,
    showsAuthor,
    visibleReplies,
  } from './lib/thread'

  interface Props {
    comment: PlanComment
    /** The thread the reader is in. Deepens the fill, thickens the edge, and
     *  is the one state that earns a shadow. */
    focused?: boolean
    /** False once the highlight has scrolled out of the reading viewport —
     *  which is the only time the card quotes its anchor back. */
    anchorVisible?: boolean
    /** Which viewport edge this card is holding, once it is the focused thread
     *  and its anchor has scrolled away. Null while it rides its own line. */
    stickyEdge?: 'top' | 'bottom' | null
    /** True while the rail is in motion. Everything decorative — shadow, verbs,
     *  the reply hint — is suppressed so the margin is quiet during a scroll. */
    moving?: boolean
    editing?: boolean
    /** Ticking clock, so times age without the card owning a timer each. */
    now: number
    onFocus: () => void
    onResolve: (resolved: boolean) => void
    onReply: (text: string) => void
    onStartEdit: () => void
    onSaveEdit: (text: string) => void
    onCancelEdit: () => void
    onDelete: () => void
  }

  let {
    comment,
    focused = false,
    anchorVisible = true,
    stickyEdge = null,
    moving = false,
    editing = false,
    now,
    onFocus,
    onResolve,
    onReply,
    onStartEdit,
    onSaveEdit,
    onCancelEdit,
    onDelete,
  }: Props = $props()

  const author = $derived(commentAuthor(comment))
  const resolved = $derived(isResolved(comment))
  const unread = $derived(isUnread(comment))
  const replies = $derived(visibleReplies(comment))

  // Resolved threads collapse to one sage row; "Show" re-expands this one
  // without unresolving it, so the reader can read a settled conversation.
  let showResolved = $state(false)
  let allRepliesShown = $state(false)
  let replying = $state(false)

  const shownReplies = $derived(allRepliesShown ? (comment.replies ?? []) : replies.shown)

  /**
   * Resolving is a 400ms fade to sage, and only then does the thread collapse —
   * so the reader sees which card settled. Holding the resolve back until the
   * fade is over is what makes the cards below rise *after* it rather than
   * during, which would read as the margin snapping shut under the pointer.
   */
  const SETTLE_MS = 400
  let settling = $state(false)
  let settleTimer: ReturnType<typeof setTimeout> | null = null

  function handleResolve() {
    if (resolved) {
      onResolve(false)
      return
    }
    if (settling) return
    settling = true
    settleTimer = setTimeout(() => {
      settling = false
      settleTimer = null
      onResolve(true)
    }, SETTLE_MS)
  }

  $effect(() => () => {
    if (settleTimer) clearTimeout(settleTimer)
  })

  function activate(e: MouseEvent | KeyboardEvent) {
    if ((e.target as HTMLElement).closest('button, a, textarea')) return
    onFocus()
  }
</script>

{#if resolved && !showResolved}
  <!-- Resolved: one sage row. The dotted trace in the text stays, so the
       conversation is still findable — it never disappears silently. -->
  <div class="ctc-resolved-row" data-comment-id={comment.id}>
    <span class="ctc-resolved-row__dot" aria-hidden="true"></span>
    <span class="ctc-resolved-row__label"
      >Resolved · {authorName(comment.resolvedBy ?? 'you')}</span
    >
    <button type="button" class="ctc-text-btn" onclick={() => (showResolved = true)}>Show</button>
  </div>
{:else}
  <div
    class="ctc"
    class:ctc--focused={focused}
    class:ctc--unread={unread}
    class:ctc--solus={author === 'solus'}
    class:ctc--resolved={resolved}
    class:ctc--stuck={!!stickyEdge}
    class:ctc--moving={moving}
    class:ctc--settling={settling}
    data-comment-id={comment.id}
    data-testid="comment-thread"
    role="button"
    tabindex="0"
    onclick={activate}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        activate(e)
      }
    }}
  >
    {#if focused}<span class="ctc__edge" aria-hidden="true"></span>{/if}

    <div class="ctc__head">
      {#if unread}<span class="ctc__unread" aria-label="Unread"></span>{/if}
      {#if author === 'solus'}
        <span class="ctc__spark" aria-hidden="true">✦</span>
      {:else}
        <span class="ctc__avatar" aria-hidden="true">{authorInitials(author)}</span>
      {/if}
      <span class="ctc__author">{authorLabel(comment)}</span>
      {#if comment.createdAt}
        <span class="ctc__time">{threadTime(comment.createdAt, now)}</span>
      {/if}

      <!-- Verbs are type, never filled buttons — a thread is a note, not a
           toolbar. They appear on hover or focus and are gone otherwise. -->
      <div class="ctc__verbs">
        {#if !editing}
          <button type="button" class="ctc-text-btn" onclick={onStartEdit}>Edit</button>
          <button type="button" class="ctc-text-btn" onclick={onDelete}>Delete</button>
        {/if}
        <button
          type="button"
          class="ctc-text-btn"
          data-testid="resolve-comment"
          onclick={handleResolve}>{resolved ? 'Reopen' : 'Resolve'}</button
        >
      </div>
    </div>

    <!-- The highlight in the text is the real anchor. This quote is the
         fallback for when it has scrolled away, so it is a caption. A stuck
         card also offers the way back to the line it belongs to. -->
    {#if !anchorVisible}
      <div class="ctc__anchor-row">
        <div class="ctc__anchor">“{comment.selectedText}”</div>
        {#if stickyEdge}
          <button type="button" class="ctc-text-btn ctc__back" onclick={onFocus}
            >{stickyEdge === 'top' ? '↑' : '↓'}</button
          >
        {/if}
      </div>
    {/if}

    <!-- The one nested scroller the document allows: a focused thread that has
         outgrown the reading viewport scrolls its own replies rather than
         pushing every card below it off the page. -->
    <div class="ctc__convo">
      {#if editing}
        <!-- Stop click and keydown reaching the card's activate handler, or
             Space typed in the editor would scroll to the mark instead. -->
        <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="presentation">
          <PlanCommentEditor
            initialValue={comment.comment}
            onSave={onSaveEdit}
            onCancel={onCancelEdit}
          />
        </div>
      {:else}
        <CommentBody text={comment.comment} clamp />
      {/if}

      {#if replies.earlierCount > 0 && !allRepliesShown}
        <button type="button" class="ctc-text-btn ctc__earlier" onclick={() => (allRepliesShown = true)}
          >{replies.earlierCount} earlier {replies.earlierCount === 1 ? 'reply' : 'replies'}</button
        >
      {/if}

      {#each shownReplies as reply, i (reply.id)}
        <div class="ctc__reply">
          {#if reply.author === 'solus'}
            <span class="ctc__spark ctc__spark--reply" aria-hidden="true">✦</span>
          {:else}
            <span class="ctc__reply-avatar" aria-hidden="true">{authorInitials(reply.author)}</span>
          {/if}
          <div class="ctc__reply-text">
            {#if showsAuthor(shownReplies, i)}
              <span class="ctc__reply-author">{authorLabel(reply)}</span>
              <span class="ctc__time">{threadTime(reply.createdAt, now)}</span>
            {/if}
            <CommentBody text={reply.text} />
          </div>
        </div>
      {/each}
    </div>

    <div class="ctc__footer">
      {#if replying}
        <div class="w-full" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="presentation">
          <PlanCommentEditor
            initialValue=""
            placeholder="Reply…"
            onSave={(text) => {
              onReply(text)
              replying = false
            }}
            onCancel={() => (replying = false)}
          />
        </div>
      {:else}
        <span class="ctc__reply-avatar" aria-hidden="true">You</span>
        <button type="button" class="ctc__reply-open" onclick={() => (replying = true)}>Reply…</button>
        <span class="ctc__hint">⌘↵</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* One thread. Amber wash over --card with a 1px amber edge — never a shadow
     at rest, because the tint and the edge are what tie it to the highlight. */
  .ctc {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.6875rem 0.75rem;
    border: 0.0625rem solid color-mix(in srgb, var(--solus-art-2) 55%, transparent);
    border-radius: 0.625rem;
    background: color-mix(in srgb, var(--solus-art-2) 9%, var(--solus-container-bg));
    text-align: left;
    cursor: pointer;
    outline: none;
    transition:
      background var(--duration-quick) var(--ease-premium),
      border-color var(--duration-quick) var(--ease-premium),
      box-shadow var(--duration-quick) var(--ease-premium);
  }
  /* Focused: deeper fill, a 2px amber edge in the margin, and the one shadow
     the card is ever allowed. Hover is not a state — it only reveals verbs. */
  .ctc--focused {
    border-color: color-mix(in srgb, var(--solus-art-2) 75%, transparent);
    background: color-mix(in srgb, var(--solus-art-2) 16%, var(--solus-container-bg));
    box-shadow: 0 0.5rem 1.375rem -0.875rem rgba(0, 0, 0, 0.45);
  }
  .ctc__edge {
    position: absolute;
    left: -0.5625rem;
    top: 0.5625rem;
    bottom: 0.5625rem;
    width: 0.125rem;
    border-radius: 999px;
    background: var(--solus-art-2);
  }
  /* Solus: terracotta, and a ✦ where the avatar would be. */
  .ctc--solus {
    border-color: color-mix(in srgb, var(--solus-accent) 30%, transparent);
    background: color-mix(in srgb, var(--solus-accent) 6%, var(--solus-container-bg));
  }
  .ctc--solus.ctc--focused {
    border-color: color-mix(in srgb, var(--solus-accent) 55%, transparent);
    background: color-mix(in srgb, var(--solus-accent) 11%, var(--solus-container-bg));
  }
  .ctc--solus .ctc__edge {
    background: var(--solus-accent);
  }
  .ctc--resolved {
    border-color: color-mix(in srgb, var(--solus-art-3) 40%, transparent);
    background: color-mix(in srgb, var(--solus-art-3) 6%, var(--solus-container-bg));
  }
  /* Resolving: 400ms to sage, and only then does the thread collapse. The card
     announces where it went instead of blinking out from under the pointer. */
  .ctc--settling {
    border-color: color-mix(in srgb, var(--solus-art-3) 55%, transparent);
    background: color-mix(in srgb, var(--solus-art-3) 12%, var(--solus-container-bg));
    transition:
      background 400ms var(--ease-premium),
      border-color 400ms var(--ease-premium);
  }
  /* Stuck to a viewport edge because the thread you are in has scrolled past
     its own line. It is the only card allowed a shadow besides focus, and it
     earns one here because it is floating over cards that are on their lines. */
  .ctc--stuck {
    box-shadow: 0 0.625rem 1.75rem -1rem rgba(0, 0, 0, 0.55);
  }
  /* In motion: cards track their anchors and nothing else. No shadow to smear
     across the margin, no verbs surfacing under a pointer that is only passing. */
  .ctc--moving {
    box-shadow: none;
  }
  .ctc--moving .ctc__verbs,
  .ctc--moving .ctc__hint {
    opacity: 0;
  }
  .ctc:focus-visible {
    box-shadow: 0 0 0 0.125rem var(--solus-input-focus-ring);
  }

  .ctc__head {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
  }
  /* Unread — a filled amber dot, and the author steps up to ink 100. */
  .ctc__unread {
    flex-shrink: 0;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 999px;
    background: var(--solus-art-2);
  }
  /* Terracotta, because in this document there is one human and it is you —
     the same hue the reply affordance already wears. */
  .ctc__avatar,
  .ctc__reply-avatar {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: var(--solus-accent);
    color: var(--solus-text-on-accent);
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .ctc__avatar {
    width: 1.1875rem;
    height: 1.1875rem;
    font-size: 0.5rem;
  }
  .ctc__reply-avatar {
    width: 1.0625rem;
    height: 1.0625rem;
    font-size: 0.46875rem;
  }
  .ctc__spark {
    flex-shrink: 0;
    font-size: 0.6875rem;
    line-height: 1.1875rem;
    color: var(--solus-accent);
  }
  /* A Solus reply gets the same mark, sized to the reply avatar it stands in
     for, so the column of avatars keeps one left edge. */
  .ctc__spark--reply {
    width: 1.0625rem;
    text-align: center;
    font-size: 0.625rem;
    line-height: 1.0625rem;
  }
  /* The only bold text in the card. */
  .ctc__author {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--solus-text-primary);
  }
  .ctc--solus .ctc__author {
    color: var(--solus-accent);
  }
  .ctc__time {
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    font-variant-numeric: tabular-nums;
  }
  .ctc__verbs {
    margin-left: auto;
    display: flex;
    gap: 0.5rem;
    opacity: 0;
    transition: opacity var(--duration-quick) var(--ease-premium);
  }
  .ctc:hover .ctc__verbs,
  .ctc--focused .ctc__verbs,
  .ctc:focus-visible .ctc__verbs,
  .ctc__verbs:focus-within {
    opacity: 1;
  }
  .ctc-text-btn {
    padding: 0;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition: color var(--duration-quick) var(--ease-premium);
  }
  .ctc-text-btn:hover {
    color: var(--solus-text-primary);
  }
  .ctc-text-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.125rem;
    border-radius: 0.25rem;
  }
  /* The quoted anchor, with the amber rule that ties it to the highlight. */
  .ctc__anchor-row {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    min-width: 0;
  }
  .ctc__anchor-row .ctc__anchor {
    flex: 1;
  }
  /* Back to the anchor: an arrow, not a labelled button — the card has already
     said what it is attached to, this only says which way. */
  .ctc__back {
    flex-shrink: 0;
    font-size: 0.75rem;
    line-height: 1;
  }
  .ctc__anchor {
    font-size: 0.6875rem;
    line-height: 1.5;
    color: var(--solus-text-tertiary);
    border-left: 0.125rem solid color-mix(in srgb, var(--solus-art-2) 55%, transparent);
    padding-left: 0.4375rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The conversation: body, earlier-replies affordance and the replies, as one
     block so it can become the card's single scroller when focused. */
  .ctc__convo {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }
  /* 40% of the reading viewport, capped — past that a thread is long enough
     that scrolling it beats letting it displace every card below it. */
  .ctc--focused .ctc__convo {
    max-height: min(calc(var(--doc-viewport-h, 100vh) * 0.4), 26.25rem);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .ctc__earlier {
    align-self: flex-start;
  }
  /* Replies are rows in the same container, not nested cards — indented only
     by the reply avatar. */
  .ctc__reply {
    display: flex;
    gap: 0.4375rem;
  }
  .ctc__reply-text {
    min-width: 0;
    font-size: 0.75rem;
    line-height: 1.55;
  }
  .ctc__reply-author {
    font-weight: 600;
    color: var(--solus-text-primary);
    margin-right: 0.25rem;
  }
  .ctc__footer {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    padding-top: 0.4375rem;
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-art-border) 55%, transparent);
  }
  .ctc__reply-open {
    padding: 0;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: 0.71875rem;
    color: var(--solus-text-tertiary);
    cursor: pointer;
  }
  .ctc__reply-open:hover {
    color: var(--solus-text-primary);
  }
  .ctc__hint {
    margin-left: auto;
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: 0.625rem;
    color: color-mix(in srgb, var(--solus-text-tertiary) 70%, transparent);
    opacity: 0;
    transition: opacity var(--duration-quick) var(--ease-premium);
  }
  .ctc:hover .ctc__hint {
    opacity: 1;
  }

  /* Resolved, collapsed: sage dot and a line of type. No card, no border —
     a settled thread has stopped asking for the margin. */
  .ctc-resolved-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.125rem;
    font-size: 0.71875rem;
    color: var(--solus-text-tertiary);
  }
  .ctc-resolved-row__dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--solus-art-3) 70%, transparent);
  }
  .ctc-resolved-row__label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ctc-resolved-row .ctc-text-btn {
    margin-left: auto;
  }

  @media (max-width: 767px) {
    .ctc__verbs {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ctc,
    .ctc__verbs,
    .ctc__hint,
    .ctc-text-btn {
      transition: none !important;
    }
  }
</style>
