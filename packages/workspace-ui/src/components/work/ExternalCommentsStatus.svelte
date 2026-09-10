<script lang="ts">
  import { docProviderLabel } from './lib/work-publish'
  import { RefreshCw as RefreshIcon, TriangleAlert as WarningIcon } from '@lucide/svelte'
  import { getWorkspaceContext } from '../../contexts'
  import { Button } from '../ui/button'

  let { workId, showResolved, onToggleResolved }: {
    workId: string
    showResolved: boolean
    onToggleResolved: () => void
  } = $props()
  const workspace = getWorkspaceContext()
  const store = workspace.worksStore.externalComments
  const provider = $derived(workspace.worksStore.get(workId)?.mirroredDoc?.provider ?? 'gdrive')
  const providerLabel = $derived(provider === 'gdrive' ? 'Google Docs' : docProviderLabel(provider))
  const snapshot = $derived(store.stateFor(workId))
  const busy = $derived(store.busy.get(workId) ?? false)
  const error = $derived(store.errors.get(workId) ?? snapshot?.error)
  const unsettled = $derived(snapshot?.operations.filter(operation => (operation.status === 'failed' || operation.status === 'uncertain') && operation.error) ?? [])
  let checking = $state(false)

  async function refresh() {
    checking = true
    try { await store.load(workId, true) } finally { checking = false }
  }
</script>

<!-- One line of the rail's own micro chrome, not a panel: where the shared
     threads come from and when they were last read. The threads themselves are
     cards in the margin below, beside the text they annotate. -->
<div class="ecs">
  <div class="ecs__row">
    <span class="ecs__origin">{providerLabel}</span>
    <span class="ecs__meta">
      {#if checking}Refreshing{:else if !snapshot}Loading{:else if snapshot.checkedAt}{new Date(snapshot.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}{/if}
    </span>
    <button type="button" class="ecs__verb" onclick={onToggleResolved} aria-pressed={showResolved}>
      {showResolved ? 'Hide resolved' : 'Show resolved'}
    </button>
    <!-- The row is 12px on every display, so the glyph is too: `icon-xs` would
         otherwise force it to 14px through its own `[&_svg:not([class*='size-'])]`
         rule and leave the mark looking a size too big for the caption beside
         it. Giving the glyph a `size-*` of its own stands that rule down.
         The only axis that does vary is the hand — a 24px target is a thumb's
         miss, so touch takes the same 40px rung the menu rows use. -->
    <Button
      variant="ghost"
      size="icon-xs"
      class="pointer-coarse:size-10"
      onclick={refresh}
      disabled={checking || busy}
      title={`Refresh from ${providerLabel}`}
      aria-label={`Refresh from ${providerLabel}`}
    >
      <RefreshIcon class="size-3 pointer-coarse:size-4" />
    </Button>
  </div>

  {#if error}
    <p role="alert" class="ecs__alert"><WarningIcon size={12} />{error} Refresh to try again.</p>
  {/if}
  {#each unsettled as operation (operation.requestId)}
    <p role="status" class="ecs__alert">
      <WarningIcon size={12} />
      {operation.error}
    </p>
  {/each}
</div>

<style>
  .ecs {
    flex-shrink: 0;
    padding: 0 0.125rem 0.5rem;
    font-size: var(--text-xs);
    line-height: 1.5;
  }
  .ecs__row {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    min-width: 0;
  }
  /* The same micro voice as the rail's own count line above it. */
  .ecs__origin {
    flex-shrink: 0;
    color: color-mix(in srgb, var(--solus-art-3) 80%, var(--solus-text-tertiary));
    white-space: nowrap;
  }
  .ecs__meta {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--solus-text-tertiary);
    font-variant-numeric: tabular-nums;
  }
  .ecs__verb {
    flex-shrink: 0;
    margin-left: auto;
    padding: 0;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: inherit;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition: color var(--duration-quick) var(--ease-premium);
  }
  .ecs__verb:hover {
    color: var(--solus-text-primary);
  }
  .ecs__verb:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.125rem;
    border-radius: 0.25rem;
  }
  .ecs__alert {
    display: flex;
    align-items: flex-start;
    gap: 0.3125rem;
    padding-top: 0.25rem;
    color: var(--solus-art-2);
    overflow-wrap: anywhere;
  }
  .ecs__alert :global(svg) {
    flex-shrink: 0;
    margin-top: 0.1875rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .ecs__verb {
      transition: none !important;
    }
  }
</style>
