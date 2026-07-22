<script lang="ts">
  import { CodeIcon, OpenAiLogoIcon } from "phosphor-svelte";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import {
    entryTitle,
    entryByline,
    formatTimeAgo,
    getStatusIcon,
    type PickerEntry,
    type StatusIcon,
  } from "../../lib/sessionUtils";
  import type { AgentId } from "../../../shared/types";

  const settings = getSettingsContext();

  interface Props {
    item: PickerEntry;
    isSelected: boolean;
    isActiveTab?: boolean;
    onSelect: () => void;
    onHover: () => void;
  }
  let { item, isSelected, onSelect, onHover }: Props = $props();

  const title = $derived(entryTitle(item));

  const byline = $derived(entryByline(item));

  const statusIcon = $derived.by<StatusIcon | null>(() => {
    if (item.kind === "open") {
      return getStatusIcon(item.session.status);
    }
    if (item.kind === "history" && item.meta.status)
      return getStatusIcon(item.meta.status);
    return null;
  });

  const isOpen = $derived(item.kind === "open");
  const provider = $derived<AgentId>(
    item.kind === "open"
      ? (item.session.provider ?? settings.activeAgent)
      : item.meta.provider,
  );
  const providerLabel = $derived(
    provider === "codex"
      ? "Codex"
      : provider === "opencode"
        ? "OpenCode"
        : "Claude Code",
  );
  const ProviderIcon = $derived(
    provider === "codex"
      ? OpenAiLogoIcon
      : provider === "opencode"
        ? CodeIcon
        : null,
  );

  const timestamp = $derived.by(() => {
    if (item.kind === "open") {
      const msgs = item.session.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const ts = msgs[i].timestamp;
        if (ts) return new Date(ts).toISOString();
      }
      return null;
    }
    return item.meta.lastTimestamp;
  });

  const timeAgo = $derived(timestamp ? formatTimeAgo(timestamp) : null);

  // Provider-specific icon color/background/ring. The ring is folded into the
  // box-shadow alongside the shared inner highlight.
  const iconClass = $derived(
    provider === "codex"
      ? "text-[var(--solus-text-secondary)] bg-[color-mix(in_srgb,var(--solus-text-primary)_7%,transparent)] shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--solus-text-primary)_12%,transparent),0_0.0625rem_0.125rem_rgba(0,0,0,0.04)]"
      : provider === "opencode"
        ? "text-[var(--solus-text-secondary)] bg-[color-mix(in_srgb,var(--solus-accent)_9%,transparent)] shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--solus-accent)_14%,transparent),0_0.0625rem_0.125rem_rgba(0,0,0,0.04)]"
        : "text-[#c15f2c] bg-[color-mix(in_srgb,#c15f2c_12%,transparent)] shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,#c15f2c_18%,transparent),0_0.0625rem_0.125rem_rgba(0,0,0,0.04)]",
  );
</script>

<button
  class="group relative flex h-full w-full cursor-pointer items-center border-none bg-transparent px-2 text-left focus-visible:outline-none"
  onclick={onSelect}
  onmouseenter={onHover}
>
  <div
    class="relative flex w-full items-center rounded-[0.625rem] px-3 py-1.5 group-focus-visible:shadow-[inset_0.125rem_0_0_var(--solus-accent),0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_22%,transparent)]
      {isSelected
      ? 'bg-[var(--solus-accent-light)] group-hover:bg-[var(--solus-accent-soft)]'
      : 'group-hover:bg-(--solus-surface-hover)'}"
  >
    <span
      class="relative mr-[0.5625rem] inline-flex h-[1.375rem] w-[1.375rem] flex-shrink-0 items-center justify-center rounded-[0.4375rem] {statusIcon
        ? 'opacity-100'
        : 'opacity-[0.92]'} {iconClass}"
      aria-label={providerLabel}
      title={providerLabel}
    >
      {#if provider === "claude-code"}
        <ClaudeIcon size={14} />
      {:else if ProviderIcon}
        <ProviderIcon
          size={14}
          weight={provider === "codex" ? "regular" : "fill"}
        />
      {/if}
      {#if statusIcon}
        {@const Icon = statusIcon.component}
        <span
          class="absolute -bottom-1 -right-1 inline-flex h-[0.8125rem] w-[0.8125rem] items-center justify-center rounded-full bg-[var(--solus-popover-bg)] shadow-[0_0_0_0.0625rem_var(--solus-popover-border)] {statusIcon.spin
            ? 'animate-spin'
            : ''}"
          style="color:{statusIcon.color}"
        >
          <Icon size={12} weight="regular" />
        </span>
      {/if}
    </span>

    <div class="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <div class="flex min-w-0 items-center gap-2">
        <span
          class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] leading-[1.3] tracking-[-0.01em] text-[var(--solus-text-primary)] {isSelected
            ? 'font-[550]'
            : 'font-[450]'}">{title}</span
        >
        {#if isOpen}
          <span
            class="h-[0.3125rem] w-[0.3125rem] flex-shrink-0 rounded-full bg-[var(--solus-accent)] opacity-85"
            aria-label="Open tab"
          ></span>
        {/if}
      </div>

      <div class="flex min-w-0 items-center gap-3">
        <span
          class="min-w-0 flex-shrink overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] tracking-[0.005em] text-[var(--solus-text-tertiary)]"
          >{byline}</span
        >
        {#if timeAgo}
          <span
            class="flex-shrink-0 text-[0.6875rem] text-[var(--solus-text-tertiary)] opacity-70 [font-variant-numeric:tabular-nums]"
            >{timeAgo}</span
          >
        {/if}
      </div>
    </div>
  </div>
</button>
