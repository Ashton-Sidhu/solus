<script lang="ts">
  import { Code as CodeIcon, Globe as GlobeIcon } from "@lucide/svelte";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";
  import { getSettingsContext, serversStore } from "../../contexts";
  import {
    entryTitle,
    entryByline,
    formatTimeAgo,
    getStatusIcon,
    getStatusLabel,
    type PickerEntry,
    type StatusIcon,
  } from "../../lib/sessionUtils";
  import { highlightRuns } from "../../lib/searchHighlight";
  import type { AgentId } from "@solus/contracts/types";

  const settings = getSettingsContext();

  interface Props {
    item: PickerEntry;
    isSelected: boolean;
    isActiveTab?: boolean;
    /** The picker's live search term, so the row can mark what matched. */
    query?: string;
    onSelect: () => void;
    onHover: () => void;
  }
  let { item, isSelected, query = "", onSelect, onHover }: Props = $props();

  // Which machine runs this session. An open tab earns the badge as much as a
  // history row does: the picker mixes hosts freely, so "here" has to be stated
  // rather than assumed. `hostFor` returns null for this machine.
  const host = $derived(
    serversStore.hostFor(
      item.kind === "history" ? item.meta.serverId : item.session.run.serverId,
    ),
  );
  const remoteHost = $derived(host && !host.local ? host : null);

  const titleRuns = $derived(highlightRuns(entryTitle(item), query));

  const bylineRuns = $derived(highlightRuns(entryByline(item), query));

  // What the session is doing. The "Open" section of the picker already says
  // which rows are open tabs, so the status icon takes that spot beside the
  // title instead of riding on the provider logo. The label names the icon for
  // a screen reader and on hover.
  const status = $derived(
    item.kind === "open" ? item.session.status : item.meta.status,
  );
  const statusLabel = $derived(status ? getStatusLabel(status) : null);
  const statusIcon = $derived<StatusIcon | null>(
    status ? getStatusIcon(status) : null,
  );

  const provider = $derived<AgentId>(
    item.kind === "open"
      ? (item.session.run.provider ?? settings.activeAgent)
      : item.meta.provider,
  );
  const providerLabel = $derived(
    provider === "codex"
      ? "Codex"
      : provider === "opencode"
        ? "OpenCode"
        : "Claude Code",
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

<!-- A stationary pointer must not reclaim selection as keyboard scrolling moves
     virtualized rows underneath it. -->
<button
  class="group relative flex h-full w-full cursor-pointer items-center border-none bg-transparent px-2 text-left focus-visible:outline-none"
  onclick={onSelect}
  onmousemove={onHover}
>
  <div
    class="relative flex w-full items-center rounded-lg px-3 py-1.5 group-focus-visible:shadow-[inset_0.125rem_0_0_var(--solus-accent),0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_22%,transparent)] max-md:h-full max-md:gap-[11px] max-md:rounded-xl max-md:px-3
 {isSelected
 ? 'bg-[var(--solus-accent-light)] group-hover:bg-[var(--solus-accent-soft)]'
 : 'group-hover:bg-(--solus-surface-hover)'}"
  >
    <span
      class="relative mr-[0.5625rem] inline-flex h-[1.375rem] w-[1.375rem] flex-shrink-0 items-center justify-center rounded-lg opacity-[0.92] max-md:mr-0 max-md:size-7 {iconClass}"
      aria-label={providerLabel}
      title={providerLabel}
    >
      {#if provider === "claude-code"}
        <ClaudeIcon size={14} />
      {:else if provider === "codex"}
        <OpenAIBlossom size={14} fill="currentColor" />
      {:else if provider === "opencode"}
        <CodeIcon size={14} />
      {/if}
    </span>

    <div class="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <div class="flex min-w-0 items-center gap-2">
        <span
          class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap leading-[1.3] text-[var(--solus-text-primary)] max-md:text-sm {isSelected
 ? 'font-medium'
 : 'font-normal'}"
          >{#each titleRuns as run, i (i)}{#if run.hit}<mark
                class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_22%,transparent)] px-px text-inherit"
                >{run.text}</mark
              >{:else}{run.text}{/if}{/each}</span
        >
        {#if statusIcon}
          {@const Icon = statusIcon.component}
          <span
            class="inline-flex flex-shrink-0 items-center justify-center {statusIcon.spin
 ? 'animate-spin'
 : ''}"
            style="color:{statusIcon.color}"
            aria-label={statusLabel}
            title={statusLabel}
          >
            <Icon size={13} weight="regular" />
          </span>
        {/if}
        {#if remoteHost}
          <span
            class="flex min-w-0 max-w-[7rem] flex-shrink-0 items-center gap-1 text-xs text-[var(--solus-text-tertiary)]"
            title="Runs on {remoteHost.label}"
          >
            <GlobeIcon size={11} class="shrink-0" />
            <span class="overflow-hidden text-ellipsis whitespace-nowrap"
              >{remoteHost.label}</span
            >
          </span>
        {/if}
      </div>

      <div class="flex min-w-0 items-center gap-3">
        <span
          class="min-w-0 flex-shrink overflow-hidden text-ellipsis whitespace-nowrap text-xs text-[var(--solus-text-tertiary)]"
          >{#each bylineRuns as run, i (i)}{#if run.hit}<mark
                class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_22%,transparent)] px-px text-inherit"
                >{run.text}</mark
              >{:else}{run.text}{/if}{/each}</span
        >
        {#if timeAgo}
          <span
            class="flex-shrink-0 text-xs text-[var(--solus-text-tertiary)] opacity-70 [font-variant-numeric:tabular-nums]"
            >{timeAgo}</span
          >
        {/if}
      </div>
    </div>
  </div>
</button>
