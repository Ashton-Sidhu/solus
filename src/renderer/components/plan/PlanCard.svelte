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
    selected?: boolean
    showProject?: boolean
    onOpen: () => void
    onResume: () => void
    onToggleBookmark: () => void
    onHover?: () => void
  }
  let {
    descriptor,
    selected = false,
    showProject = true,
    onOpen,
    onResume,
    onToggleBookmark,
    onHover,
  }: Props = $props()

  const statusColor = $derived(
    descriptor.status === 'accepted'
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
  class="plan-card group"
  class:selected
  data-selected={selected ? 'true' : null}
  onclick={(e) => { if (e.shiftKey) onResume(); else onOpen(); }}
  onmouseenter={onHover}
  role="button"
  tabindex="-1"
  onkeydown={(e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) onResume(); else onOpen();
    }
  }}
>
  <div class="card-accent" style="background:{statusColor}"></div>

  <div class="card-body">
    <div class="card-header">
      <div class="card-meta">
        <span
          class="provider-badge provider-{provider}"
          aria-label={providerLabel}
          title={providerLabel}
        >
          {#if provider === 'claude-code'}
            <ClaudeIcon size={10} />
          {:else if ProviderIcon}
            <ProviderIcon size={10} weight="regular" />
          {/if}
        </span>
        {#if showProject}
          <span class="meta-text">{projectShort()}</span>
          <span class="meta-sep">/</span>
        {/if}
        <span class="meta-text">{timeLabel}</span>
        {#if descriptor.revisions.length > 1}
          <span class="revision-pip">v{descriptor.revisions.length}</span>
        {/if}
        {#if descriptor.commentCount > 0}
          <span class="comment-pip">
            <ChatCircleTextIcon size={9} />
            {descriptor.commentCount}
          </span>
        {/if}
      </div>
      <div class="card-actions">
        <button
          type="button"
          use:tooltip={"Resume session (⇧+Enter)"}
          onclick={(e) => { e.stopPropagation(); onResume(); }}
          class="card-icon-btn"
        >
          <ArrowUpRightIcon size={11} />
        </button>
        <button
          type="button"
          use:tooltip={descriptor.bookmarked ? "Remove bookmark (⌥B)" : "Bookmark (⌥B)"}
          onclick={(e) => { e.stopPropagation(); onToggleBookmark(); }}
          class="card-icon-btn"
          class:is-active={descriptor.bookmarked}
          class:always-show={descriptor.bookmarked}
        >
          <BookmarkSimpleIcon size={11} weight={descriptor.bookmarked ? 'fill' : 'regular'} />
        </button>
      </div>
    </div>

    <div class="plan-title">{descriptor.title}</div>
    <div class="plan-excerpt">{descriptor.excerpt}</div>
  </div>
</div>

<style>
  .plan-card {
    position: relative;
    display: flex;
    width: 100%;
    border-radius: 0.625rem;
    background: var(--solus-container-bg);
    border: 0.0625rem solid transparent;
    box-shadow: 0 0.0625rem 0.1875rem rgba(0, 0, 0, 0.04), 0 0.0625rem 0.125rem rgba(0, 0, 0, 0.02);
    transition: border-color 200ms ease, box-shadow 200ms ease;
    cursor: pointer;
    user-select: none;
    outline: none;
    overflow: hidden;
  }
  .plan-card:hover {
    border-color: color-mix(in srgb, var(--solus-accent) 20%, var(--solus-container-border));
    box-shadow: 0 0.125rem 0.5rem rgba(0, 0, 0, 0.06), 0 0.0625rem 0.1875rem rgba(0, 0, 0, 0.04);
  }
  .plan-card:focus-visible,
  .plan-card.selected {
    border-color: color-mix(in srgb, var(--solus-accent) 40%, var(--solus-container-border));
    box-shadow: 0 0.125rem 0.5rem rgba(0, 0, 0, 0.06), 0 0.0625rem 0.1875rem rgba(0, 0, 0, 0.04), 0 0 0 0.1875rem color-mix(in srgb, var(--solus-accent) 8%, transparent);
  }
  .plan-card.selected .card-accent {
    opacity: 0.95;
  }
  .plan-card.selected .card-icon-btn {
    opacity: 1;
  }

  .card-accent {
    width: 0.1875rem;
    flex-shrink: 0;
    border-radius: 0.1875rem 0 0 0.1875rem;
    opacity: 0.5;
    transition: opacity 200ms ease;
  }
  .plan-card:hover .card-accent {
    opacity: 0.85;
  }

  .card-body {
    flex: 1;
    min-width: 0;
    padding: 0.625rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .card-meta {
    display: flex;
    align-items: center;
    gap: 0.3125rem;
    font-size: 0.6563rem;
    color: var(--solus-text-tertiary);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    min-width: 0;
    overflow: hidden;
  }
  .meta-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta-sep {
    opacity: 0.35;
    flex-shrink: 0;
  }

  .provider-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    border-radius: 0.3125rem;
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

  .revision-pip {
    display: inline-flex;
    align-items: center;
    font-size: 0.5938rem;
    line-height: 1;
    padding: 0.0625rem 0.3125rem;
    border-radius: 624.9375rem;
    color: var(--solus-text-tertiary);
    background: var(--solus-surface-hover);
    flex-shrink: 0;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }

  .comment-pip {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    font-size: 0.5938rem;
    line-height: 1;
    padding: 0.0625rem 0.3125rem;
    border-radius: 624.9375rem;
    color: var(--solus-accent);
    background: var(--solus-accent-light);
    flex-shrink: 0;
  }

  .card-actions {
    display: flex;
    align-items: center;
    gap: 0.0625rem;
    flex-shrink: 0;
  }

  .card-icon-btn {
    width: 1.25rem;
    height: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.3125rem;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
    opacity: 0;
  }
  .plan-card:hover .card-icon-btn,
  .plan-card:focus-within .card-icon-btn {
    opacity: 1;
  }
  .card-icon-btn.always-show {
    opacity: 1;
  }
  .card-icon-btn:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .card-icon-btn.is-active {
    color: var(--solus-accent);
  }

  .plan-title {
    font-size: 0.8125rem;
    font-weight: 550;
    color: var(--solus-text-primary);
    line-height: 1.3;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    letter-spacing: -0.01em;
  }

  .plan-excerpt {
    font-size: 0.7188rem;
    color: var(--solus-text-tertiary);
    line-height: 1.5;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
</style>
