<script lang="ts">
  import {
    BookmarkSimpleIcon,
    ArrowUpRightIcon,
    ChatCircleTextIcon,
    CodeIcon,
    OpenAiLogoIcon,
  } from 'phosphor-svelte'
  import ClaudeIcon from '../ClaudeIcon.svelte'
  import type { AgentId, PlanDescriptor } from '../../../shared/types'
  import { formatTimeAgo } from '../../lib/sessionUtils'
  import { tooltip } from '../../lib/tooltip'

  interface Props {
    descriptor: PlanDescriptor
    selected: boolean
    showProject: boolean
    onOpen: () => void
    onResume: () => void
    onToggleBookmark: () => void
    onHover: () => void
  }
  let { descriptor, selected, showProject, onOpen, onResume, onToggleBookmark, onHover }: Props = $props()

  const leadingGlyph = $derived(
    descriptor.bookmarked
      ? '★'
      : descriptor.status === 'accepted'
        ? '✓'
        : descriptor.status === 'rejected'
          ? '✗'
          : '●',
  )
  const leadingColor = $derived(
    descriptor.bookmarked
      ? 'var(--solus-accent)'
      : descriptor.status === 'accepted'
        ? 'var(--solus-status-complete)'
        : descriptor.status === 'rejected'
          ? 'var(--solus-text-muted)'
          : 'var(--solus-accent)',
  )
  const projectShort = $derived(() => {
    const dir = descriptor.cwd?.replace(/\/$/, '')
    if (!dir || dir === '~') return '~'
    const parts = dir.split('/')
    return parts[parts.length - 1] || '~'
  })
  const timeLabel = $derived(formatTimeAgo(new Date(descriptor.timestamp).toISOString()))
  const provider = $derived<AgentId>(descriptor.provider ?? 'claude-code')
  const providerLabel = $derived(
    provider === 'codex'
      ? 'OpenAI'
      : provider === 'opencode'
        ? 'OpenCode'
        : 'Claude Code',
  )
  const ProviderIcon = $derived(
    provider === 'codex'
      ? OpenAiLogoIcon
      : provider === 'opencode'
        ? CodeIcon
        : null,
  )
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="row"
  class:selected
  data-selected={selected ? 'true' : null}
  onclick={(e) => { if (e.shiftKey) onResume(); else onOpen(); }}
  onmouseenter={onHover}
  role="button"
  tabindex="-1"
>
  <span
    class="provider-badge provider-{provider}"
    aria-label={providerLabel}
    title={providerLabel}
  >
    {#if provider === 'claude-code'}
      <ClaudeIcon size={11} />
    {:else if ProviderIcon}
      <ProviderIcon size={11} weight="regular" />
    {/if}
  </span>
  <span class="leading-glyph" style="color:{leadingColor}">{leadingGlyph}</span>
  <div class="row-body">
    <div class="row-title">{descriptor.title}</div>
    <div class="row-excerpt">{descriptor.excerpt}</div>
  </div>
  <div class="row-meta">
    {#if showProject}
      <span class="row-project" title={descriptor.cwd}>{projectShort()}</span>
    {/if}
    {#if descriptor.revisions.length > 1}
      <span class="row-revision">v{descriptor.revisions.length}</span>
    {/if}
    {#if descriptor.commentCount > 0}
      <span class="row-pip">
        <ChatCircleTextIcon size={10} />
        {descriptor.commentCount}
      </span>
    {/if}
    <span class="row-time">{timeLabel}</span>
    <div class="row-actions">
      <button
        type="button"
        use:tooltip={descriptor.bookmarked ? 'Remove bookmark (⌥B)' : 'Bookmark (⌥B)'}
        onclick={(e) => { e.stopPropagation(); onToggleBookmark(); }}
        class="row-icon-btn"
        class:is-active={descriptor.bookmarked}
        class:always-show={descriptor.bookmarked}
      >
        <BookmarkSimpleIcon size={11} weight={descriptor.bookmarked ? 'fill' : 'regular'} />
      </button>
      <button
        type="button"
        use:tooltip={'Resume session (⇧+Enter)'}
        onclick={(e) => { e.stopPropagation(); onResume(); }}
        class="row-icon-btn"
      >
        <ArrowUpRightIcon size={11} />
      </button>
    </div>
  </div>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    cursor: pointer;
    transition: background 0.1s ease;
  }
  .row:hover,
  .row.selected {
    background: var(--solus-accent-light);
  }
  .leading-glyph {
    width: 1rem;
    text-align: center;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1;
    flex-shrink: 0;
  }
  .provider-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 0.4375rem;
    color: var(--provider-icon-color);
    background: var(--provider-icon-bg);
    box-shadow: inset 0 0 0 0.0625rem var(--provider-icon-ring);
    flex-shrink: 0;
  }

  .provider-badge.provider-claude-code {
    --provider-icon-color: #c15f2c;
    --provider-icon-bg: color-mix(in srgb, #c15f2c 12%, transparent);
    --provider-icon-ring: color-mix(in srgb, #c15f2c 18%, transparent);
  }

  .provider-badge.provider-codex {
    --provider-icon-color: var(--solus-text-secondary);
    --provider-icon-bg: color-mix(in srgb, var(--solus-text-primary) 7%, transparent);
    --provider-icon-ring: color-mix(in srgb, var(--solus-text-primary) 12%, transparent);
  }

  .provider-badge.provider-opencode {
    --provider-icon-color: var(--solus-text-secondary);
    --provider-icon-bg: color-mix(in srgb, var(--solus-accent) 9%, transparent);
    --provider-icon-ring: color-mix(in srgb, var(--solus-accent) 14%, transparent);
  }
  .row-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .row-title {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--solus-text-primary);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-excerpt {
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .row-project {
    font-size: 0.625rem;
    color: var(--solus-text-tertiary);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    max-width: 5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-revision {
    font-size: 0.625rem;
    color: var(--solus-text-tertiary);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    padding: 0 0.25rem;
    border-radius: 0.25rem;
    background: var(--solus-surface-hover);
  }
  .row-pip {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    font-size: 0.625rem;
    color: var(--solus-accent);
  }
  .row-time {
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    font-variant-numeric: tabular-nums;
  }
  .row-actions {
    display: flex;
    gap: 0.125rem;
  }
  .row-icon-btn {
    width: 1.25rem;
    height: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    opacity: 0;
    transition: opacity 0.1s ease, background 0.1s ease, color 0.1s ease;
  }
  .row:hover .row-icon-btn,
  .row.selected .row-icon-btn {
    opacity: 1;
  }
  .row-icon-btn.always-show {
    opacity: 1;
  }
  .row-icon-btn:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .row-icon-btn.is-active {
    color: var(--solus-accent);
  }
</style>
