<script lang="ts">
  import Icon from '@iconify/svelte'
  import { uuid } from '@solus/contracts/uuid'
  import { getWorkspaceContext } from '../../contexts'
  import { toasts } from '../../lib/toasts'
  import { ensureIconCollections } from '../diagram/iconify'
  import * as TooltipUI from '../ui/tooltip'
  import { docProviderLogo, docProviderLabel } from './lib/work-publish'
  import { outboundText, publishState, shareOperation } from './lib/external-comments-view'

  let { workId, messageId, text, quote, author }: {
    workId: string
    messageId: string
    text: string
    quote: string
    author?: 'you' | 'solus'
  } = $props()
  const store = getWorkspaceContext().worksStore.externalComments
  const workspace = getWorkspaceContext()
  const provider = $derived(workspace.worksStore.get(workId)?.mirroredDoc?.provider ?? 'gdrive')
  const providerLabel = $derived(provider === 'gdrive' ? 'Google Docs' : docProviderLabel(provider))
  const message = $derived(outboundText(text, author))
  const busy = $derived(store.busy.get(workId) ?? false)
  const operation = $derived(shareOperation(store.stateFor(workId)?.operations, messageId, message, quote))
  const state = $derived(publishState(operation, busy, message, providerLabel))
  const canCreate = $derived(store.stateFor(workId)?.capabilities?.actions.includes('create') ?? false)
  const label = $derived(canCreate || operation ? state.label : 'Comment publishing is unavailable. Refresh comments to check provider support.')
  let requestId = uuid()

  ensureIconCollections()

  async function publish() {
    if (!state.canPublish || !canCreate) return
    // A definite rejection may be retried under its own receipt; anything else
    // that has already been attempted is blocked upstream of this click.
    requestId = operation?.requestId ?? uuid()
    if (await store.send(workId, { kind: 'share', requestId, sourceMessageId: messageId, text: message, quote: quote.trim() })) {
      toasts.success(`Comment published to ${providerLabel}`)
    } else {
      toasts.error(`Couldn't publish this comment to ${providerLabel}`, { description: store.errors.get(workId) })
    }
  }
</script>

<!-- One button: the provider's own mark, and a click sends this message. Every
     state it cannot be pressed in says why in its tooltip rather than growing
     a second control. -->
<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props })}
      <!-- aria-disabled, not disabled: a disabled button takes no pointer
           events, so the tooltip explaining why would never open. -->
      <button
        {...props}
        type="button"
        class="gcp"
        data-state={state.kind}
        data-testid="publish-comment"
        aria-disabled={!state.canPublish || !canCreate}
        aria-label={label}
        onclick={event => { event.stopPropagation(); void publish() }}
        onkeydown={event => event.stopPropagation()}
      >
        <Icon icon={docProviderLogo(provider)} width={13} height={13} />
        {#if state.kind === 'published'}<span class="gcp__check" aria-hidden="true"></span>{/if}
      </button>
    {/snippet}
  </TooltipUI.Trigger>
  <TooltipUI.Content side="top" class="max-w-64 whitespace-normal">{label}</TooltipUI.Content>
</TooltipUI.Root>

<style>
  .gcp {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    padding: 0;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    cursor: pointer;
    opacity: 0.85;
    transition:
      opacity var(--duration-quick) var(--ease-premium),
      background var(--duration-quick) var(--ease-premium);
  }
  .gcp:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--solus-text-tertiary) 12%, transparent);
  }
  .gcp:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.125rem;
  }
  /* Unpressable states keep the mark legible — the reader still needs to see
     which provider this comment belongs to. */
  .gcp[aria-disabled='true'] {
    cursor: default;
    opacity: 0.4;
  }
  .gcp[aria-disabled='true']:hover {
    opacity: 0.4;
    background: transparent;
  }
  /* Published is the one state that must read at rest, without hover or a
     tooltip: full-strength mark plus a sage tick. */
  .gcp[data-state='published'] {
    opacity: 1;
  }
  .gcp[data-state='published']:hover {
    opacity: 1;
  }
  .gcp__check {
    position: absolute;
    right: -0.0625rem;
    bottom: -0.0625rem;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 9999px;
    background: var(--solus-art-3);
    box-shadow: 0 0 0 0.09375rem var(--solus-popover-bg);
  }

  @media (prefers-reduced-motion: reduce) {
    .gcp {
      transition: none !important;
    }
  }
</style>
