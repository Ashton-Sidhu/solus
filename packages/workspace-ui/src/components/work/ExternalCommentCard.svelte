<script lang="ts">
  import Icon from '@iconify/svelte'
  import { Check as CheckIcon, LoaderCircle as SpinnerIcon } from '@lucide/svelte'
  import type { DocCommentThread } from '@solus/contracts/work-comments'
  import { uuid } from '@solus/contracts/uuid'
  import { getSurfaceContext } from '../../contexts'
  import { ensureIconCollections } from '../diagram/iconify'
  import { CommentComposer } from '../ui/comment-composer'
  import { externalCommentDate, externalCommentBody, externalCommentQuote } from './lib/external-comments-view'
  import { docProviderLogo, docProviderLabel } from './lib/work-publish'

  let { workId, thread, focused = false, moving = false, onFocus, onAskPrivately, onLocateQuote }: {
    workId: string
    thread: DocCommentThread
    /** The thread the reader is in — the same edge and shadow a local card
     *  earns, so focus reads the same whichever kind of thread holds it. */
    focused?: boolean
    /** True while the rail is in motion: the shadow is dropped so nothing
     *  smears across the margin during a scroll. */
    moving?: boolean
    onFocus?: () => void
    onLocateQuote: (quote: string, threadId: string) => boolean
    onAskPrivately: (thread: DocCommentThread) => void
  } = $props()
  const store = getSurfaceContext().worksStore.externalComments
  const workspace = getSurfaceContext()
  const provider = $derived(workspace.worksStore.get(workId)?.mirroredDoc?.provider ?? 'gdrive')
  const providerLabel = $derived(provider === 'gdrive' ? 'Google Docs' : docProviderLabel(provider))
  const busy = $derived(store.busy.get(workId) ?? false)
  let quoteMissing = $state(false)
  let showEarlier = $state(false)
  let replying = $state(false)
  let resolving = $state(false)
  const quote = $derived(externalCommentQuote(thread))
  const replies = $derived(thread.replies.filter(reply => !reply.deleted))
  const shownReplies = $derived(showEarlier ? replies : replies.slice(-2))
  let requestId = uuid()
  let resolveRequestId = uuid()
  ensureIconCollections()
  async function reply(text: string) {
    if (await store.send(workId, { kind: 'reply', requestId, threadId: thread.id, text })) {
      requestId = uuid()
      replying = false
    }
  }
  async function resolve() {
    if (busy || resolving) return
    resolving = true
    try {
      if (await store.send(workId, { kind: thread.resolved ? 'reopen' : 'resolve', requestId: resolveRequestId, threadId: thread.id })) resolveRequestId = uuid()
    } finally { resolving = false }
  }
  /** The card is the thread's handle: a click anywhere on it that is not a
   *  control focuses the thread and brings its highlight into view. */
  function activate(e: MouseEvent | KeyboardEvent) {
    if (e.target instanceof Element && e.target.closest('button, a, textarea, [contenteditable]')) return
    onFocus?.()
  }
</script>

<!-- A thread that lives in Google Docs. The same surface as a local thread so
     the two read as one margin; the sage origin line at the head is what says
     everything on this card goes back to the document. -->
<article
  class="gcc"
  class:gcc--focused={focused}
  class:gcc--moving={moving}
  class:gcc--resolved={thread.resolved}
  data-testid="external-comment-thread"
  role="button"
  tabindex="0"
  onclick={activate}
  onkeydown={(e) => {
    if (e.target instanceof Element && e.target.closest('button, a, textarea, [contenteditable]')) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate(e)
    }
  }}
>
  {#if focused}<span class="gcc__edge" aria-hidden="true"></span>{/if}

  <!-- One line, always: the author yields before the origin or the time does.
       Where the thread lives is the one thing every reply and verb on this
       card is understood by, so it never wraps out of the head. -->
  <div class="gcc__head">
    <span class="gcc__origin">
      <Icon icon={docProviderLogo(provider)} width={11} height={11} />
      {providerLabel}
    </span>
    <span class="gcc__author">{thread.author.name}</span>
    <span class="gcc__time">{externalCommentDate(thread.createdAt)}</span>
    {#if thread.resolved}
      <span class="gcc__resolved" title="Resolved"><CheckIcon size={11} aria-hidden="true" /><span class="sr-only">Resolved</span></span>
    {/if}
  </div>

  {#if quote}
    <div class="gcc__quote-row">
      <div class="gcc__quote">“{quote}”</div>
      <button type="button" class="gcc__verb" onclick={() => (quoteMissing = !onLocateQuote(quote, thread.id))}>Find</button>
    </div>
    {#if quoteMissing}
      <p role="status" class="gcc__note">That quote is missing here, or appears more than once. Nothing was selected.</p>
    {/if}
  {/if}

  {#if thread.attachmentState === 'detached'}<p class="gcc__note">Original text is no longer attached in {providerLabel}.</p>{/if}

  <!-- The conversation: body and replies as one block, so a long focused
       thread scrolls itself rather than pushing every card below it away. -->
  <div class="gcc__convo">
    <p class="gcc__body">{externalCommentBody(thread)}</p>

    {#if replies.length > 2 && !showEarlier}
      <button type="button" class="gcc__verb gcc__verb--start" onclick={() => (showEarlier = true)}>{replies.length - 2} earlier {replies.length - 2 === 1 ? 'reply' : 'replies'}</button>
    {/if}
    {#each shownReplies as reply (reply.id)}
      <div class="gcc__reply">
        <span class="gcc__reply-author">{reply.author.name}</span>
        {#if reply.action}<span class="gcc__time">{reply.action === 'resolve' ? 'resolved this' : 'reopened this'}</span>{/if}
        {#if reply.text}<p class="gcc__body">{reply.text}</p>{/if}
      </div>
    {/each}
  </div>

  <div class="gcc__footer">
    {#if replying}
      <div class="gcc__composer" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="presentation">
        <CommentComposer
          initialValue=""
          placeholder={`Reply in ${providerLabel}…`}
          submitLabel="Send"
          submitOn="enter"
          surface="embedded"
          disabled={busy}
          onSave={text => void reply(text)}
          onCancel={() => (replying = false)}
        />
      </div>
    {:else}
      {#if thread.allowedActions?.includes('reply')}<button type="button" class="gcc__verb" onclick={() => (replying = true)}>Reply…</button>{/if}
      {#if resolving}
        <span role="status" aria-label="Updating comment">
          <SpinnerIcon size={12} class="animate-spin motion-reduce:animate-none" />
        </span>
      {:else if thread.allowedActions?.includes(thread.resolved ? 'reopen' : 'resolve')}
        <button type="button" class="gcc__verb" disabled={busy} onclick={() => void resolve()}>{thread.resolved ? 'Reopen' : 'Resolve'}</button>
      {/if}
      <button
        type="button"
        class="gcc__verb gcc__verb--end"
        title={`Discuss this thread with the agent in Solus. Nothing is sent to ${providerLabel}.`}
        onclick={() => onAskPrivately(thread)}>Ask agent</button
      >
    {/if}
  </div>
</article>

<style>
  /* The same surface as a local thread — popover fill behind a 1px tinted
     edge, sage rather than amber because this thread's state is the
     provider's. Never a shadow at rest; focus is the one state that earns one. */
  .gcc {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.6875rem 0.75rem;
    border: 0.0625rem solid color-mix(in srgb, var(--solus-art-3) 32%, var(--solus-container-border));
    border-radius: 1rem;
    background: var(--solus-popover-bg);
    font-size: var(--text-xs);
    line-height: 1.55;
    text-align: left;
    min-width: 0;
    cursor: pointer;
    outline: none;
    transition:
      border-color var(--duration-quick) var(--ease-premium),
      box-shadow var(--duration-quick) var(--ease-premium);
  }
  .gcc--focused {
    border-color: color-mix(in srgb, var(--solus-art-3) 60%, var(--solus-container-border));
    box-shadow: 0 0.5rem 1.375rem -0.875rem rgba(0, 0, 0, 0.45);
  }
  .gcc--moving {
    box-shadow: none;
  }
  .gcc:focus-visible {
    box-shadow: 0 0 0 0.125rem var(--solus-input-focus-ring);
  }
  .gcc--resolved {
    border-color: color-mix(in srgb, var(--solus-art-3) 40%, transparent);
  }
  /* The margin rail a focused card carries, in the provider's sage. */
  .gcc__edge {
    position: absolute;
    left: -0.5625rem;
    top: 0.5625rem;
    bottom: 0.5625rem;
    width: 0.125rem;
    border-radius: 9999px;
    background: var(--solus-art-3);
  }
  .gcc__head {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    min-width: 0;
  }
  /* Where the thread lives, said once at the top of the card. */
  .gcc__origin {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
    white-space: nowrap;
    color: color-mix(in srgb, var(--solus-art-3) 80%, var(--solus-text-tertiary));
  }
  .gcc__author {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
    color: var(--solus-text-primary);
  }
  .gcc__time {
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
    font-variant-numeric: tabular-nums;
  }
  .gcc__resolved {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    color: color-mix(in srgb, var(--solus-art-3) 80%, var(--solus-text-tertiary));
  }
  .gcc__quote-row {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    min-width: 0;
  }
  /* The quote is a caption: Google owns the highlight, this only names it. */
  .gcc__quote {
    flex: 1;
    min-width: 0;
    padding-left: 0.4375rem;
    border-left: 0.125rem solid color-mix(in srgb, var(--solus-art-2) 55%, transparent);
    color: var(--solus-text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gcc__convo {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }
  /* The one nested scroller the margin allows, and only for the thread you
     are in: past 40% of the reading viewport a thread scrolls its own replies
     instead of displacing every card below it. */
  .gcc--focused .gcc__convo {
    max-height: min(calc(var(--doc-viewport-h, 100vh) * 0.4), 26.25rem);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .gcc__body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--solus-text-primary);
  }
  .gcc__note {
    color: var(--solus-art-2);
  }
  .gcc__reply {
    padding-left: 0.5rem;
    border-left: 0.0625rem solid color-mix(in srgb, var(--solus-art-border) 55%, transparent);
    min-width: 0;
  }
  .gcc__reply-author {
    margin-right: 0.25rem;
    font-weight: 500;
    color: var(--solus-text-primary);
  }
  /* One line of verbs. They are the card's real actions, so they stay visible
     at rest — a hand cannot hover — and they are short enough to fit the
     margin's width without wrapping into a second row. */
  .gcc__footer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
    padding-top: 0.4375rem;
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-art-border) 55%, transparent);
  }
  .gcc__composer {
    width: 100%;
  }
  /* Actions on a note are type, not a stack of filled buttons. */
  .gcc__verb {
    flex-shrink: 0;
    padding: 0;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: inherit;
    white-space: nowrap;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition: color var(--duration-quick) var(--ease-premium);
  }
  .gcc__verb:hover:not(:disabled) {
    color: var(--solus-text-primary);
  }
  .gcc__verb:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .gcc__verb:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.125rem;
    border-radius: 0.25rem;
  }
  .gcc__verb--start {
    align-self: flex-start;
  }
  .gcc__verb--end {
    margin-left: auto;
  }

  @media (prefers-reduced-motion: reduce) {
    .gcc,
    .gcc__verb {
      transition: none !important;
    }
  }
</style>
