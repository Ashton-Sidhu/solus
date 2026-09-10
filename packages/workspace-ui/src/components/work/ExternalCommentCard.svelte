<script lang="ts">
  import Icon from '@iconify/svelte'
  import { Check as CheckIcon, LoaderCircle as SpinnerIcon } from '@lucide/svelte'
  import type { DocCommentThread } from '@solus/contracts/work-comments'
  import { uuid } from '@solus/contracts/uuid'
  import { getWorkspaceContext } from '../../contexts'
  import { ensureIconCollections } from '../diagram/iconify'
  import { CommentComposer } from '../ui/comment-composer'
  import { externalCommentDate, externalCommentBody } from './lib/external-comments-view'
  import { docProviderLogo, docProviderLabel } from './lib/work-publish'

  let { workId, thread, onAskPrivately, onLocateQuote }: {
    workId: string
    thread: DocCommentThread
    onLocateQuote: (quote: string, threadId: string) => boolean
    onAskPrivately: (thread: DocCommentThread) => void
  } = $props()
  const store = getWorkspaceContext().worksStore.externalComments
  const workspace = getWorkspaceContext()
  const provider = $derived(workspace.worksStore.get(workId)?.mirroredDoc?.provider ?? 'gdrive')
  const providerLabel = $derived(provider === 'gdrive' ? 'Google Docs' : docProviderLabel(provider))
  const busy = $derived(store.busy.get(workId) ?? false)
  let quoteMissing = $state(false)
  let showEarlier = $state(false)
  let replying = $state(false)
  let resolving = $state(false)
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
</script>

<!-- A thread that lives in Google Docs. Same surface as a local thread so the
     two read as one design; the sage state line is what says everything here
     goes back to the document. -->
<article class="gcc" class:gcc--resolved={thread.resolved} data-testid="external-comment-thread">
  <div class="gcc__head">
    <span class="gcc__origin">
      <Icon icon={docProviderLogo(provider)} width={11} height={11} />
      {providerLabel}
    </span>
    <span class="gcc__author">{thread.author.name}</span>
    <span class="gcc__time">{externalCommentDate(thread.createdAt)}</span>
    {#if thread.resolved}
      <span class="gcc__resolved"><CheckIcon size={11} />Resolved</span>
    {/if}
  </div>

  {#if thread.quote}
    <div class="gcc__quote-row">
      <div class="gcc__quote">“{thread.quote}”</div>
      <button type="button" class="gcc__verb" onclick={() => (quoteMissing = !onLocateQuote(thread.quote, thread.id))}>Find in text</button>
    </div>
    {#if quoteMissing}
      <p role="status" class="gcc__note">That quote is missing here, or appears more than once. Nothing was selected.</p>
    {/if}
  {/if}

  {#if thread.attachmentState === 'detached'}<p class="gcc__note">Original text is no longer attached in {providerLabel}.</p>{/if}
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

  <div class="gcc__footer">
    {#if replying}
      <div class="gcc__composer">
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
      <button type="button" class="gcc__verb gcc__verb--end" onclick={() => onAskPrivately(thread)}>Ask agent privately</button>
    {/if}
  </div>
</article>

<style>
  .gcc {
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
  }
  .gcc--resolved {
    border-color: color-mix(in srgb, var(--solus-art-3) 40%, transparent);
  }
  .gcc__head {
    display: flex;
    flex-wrap: wrap;
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
    color: color-mix(in srgb, var(--solus-art-3) 80%, var(--solus-text-tertiary));
  }
  .gcc__author {
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
    gap: 0.25rem;
    margin-left: auto;
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
  .gcc__footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
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
    .gcc__verb {
      transition: none !important;
    }
  }
</style>
