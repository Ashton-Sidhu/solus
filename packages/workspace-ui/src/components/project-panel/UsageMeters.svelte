<script lang="ts">
  import { untrack } from "svelte";
  import { ChevronRight as ChevronRightIcon, Code as CodeIcon } from "@lucide/svelte";
  import { Progress } from "../ui/progress";
  import { getAgentContext, getWorkspaceContext, hosts, serversStore } from "../../contexts";
  import { messageTimestampClock } from "../../lib/shared-clock";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import { conversationViewStates } from "../conversation/lib/conversation-view-state.svelte";
  import { providerUsage, usageByProvider, type UsageMeter } from "./lib/usage-meters";

  interface Props {
    /** The host the tab runs on: quota belongs to that host's agent logins. */
    serverId: string;
    sourceId: string;
    antigravityModelId: string | null;
    /** The panel is mounted for every tab; only the visible one asks for a
     *  refresh, and the backend's poll suspends when nobody is watching. */
    active?: boolean;
  }
  let { serverId, sourceId, antigravityModelId, active = true }: Props = $props();

  const agent = getAgentContext();
  const workspace = getWorkspaceContext();
  const view = $derived(workspace.tabs[sourceId] ? conversationViewStates(workspace).forTab(sourceId) : null);
  let draftGroupsExpanded = $state(false);
  const groupsExpanded = $derived(view?.usageGroupsExpanded ?? draftGroupsExpanded);
  function toggleGroups() {
    if (view) view.usageGroupsExpanded = !groupsExpanded;
    else draftGroupsExpanded = !groupsExpanded;
  }
  let now = $state(Date.now());
  // A tab may name a host that was deleted; it has no quota to show.
  const host = $derived(hosts.get(serverId));
  const usageFact = $derived(host?.usage);
  const usage = $derived(usageFact?.state === "ready" ? usageByProvider(usageFact.value) : {});
  const disconnected = $derived(serversStore.readinessFor(serverId).readiness !== "ready");
  const rows = $derived(providerUsage(agent.agents, usage, now, antigravityModelId, disconnected));

  $effect(() => {
    if (!active) return;
    const watchedHost = host;
    return untrack(() => {
      // The host reads the quota while the watch holds and pushes each change.
      const releaseUsage = watchedHost?.watchUsage();
      const stopClock = messageTimestampClock.subscribe((value) => { now = value; });
      return () => {
        stopClock();
        releaseUsage?.();
      };
    });
  });

  const barTone = {
    ok: "[&_[data-slot=progress-indicator]]:bg-(--solus-status-complete)",
    low: "[&_[data-slot=progress-indicator]]:bg-(--solus-status-running)",
    spent: "[&_[data-slot=progress-indicator]]:bg-(--solus-status-error)",
  } satisfies Record<string, string>;
</script>

{#snippet windowMeters(meters: UsageMeter[])}
  <div class="flex flex-col gap-1.5 pt-0.5 pb-1.5">
    {#each meters as meter (meter.key)}
      <div class="flex flex-col gap-[0.1875rem]">
        <div class="flex items-baseline gap-1.5 text-chrome-dense">
          <span class="shrink-0 text-(--solus-text-secondary)">{meter.label}</span>
          {#if meter.resetPhrase}
            <span class="truncate text-(--solus-text-tertiary)">{meter.resetPhrase}</span>
          {/if}
          <span class="ml-auto shrink-0 tabular-nums text-(--solus-text-tertiary)">
            {meter.remainingPercent > 0 && meter.remainingPercent < 1 ? "<1" : Math.round(meter.remainingPercent)}%
          </span>
        </div>
        <Progress
          value={meter.remainingPercent}
          aria-label={`${meter.label} quota remaining`}
          class="h-[0.1875rem] bg-(--solus-surface-hover) {barTone[meter.tone]}"
        />
      </div>
    {/each}
  </div>
{/snippet}

{#if rows.length > 0 && (host?.me.may("host.usage.read") ?? true)}
  <div class="flex flex-col">
    {#each rows as row (row.provider)}
      <!-- The provider reads as a menu row — same glyph column, same size and
           weight as Files and Terminal — and its windows hang beneath it. Size
           comes from the rail, as MenuRow's does, so the two rows cannot part
           company when the display changes rung. Clicking opens Settings → Usage. -->
      <button
        type="button"
        onclick={() => workspace.showSettings("usage", "click")}
        aria-label="Open usage details for {row.label}"
        class="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-[0.3125rem] text-left text-(--solus-text-secondary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline focus-visible:outline-(--solus-accent)"
      >
        <!-- Same marks as the model picker, in the same treatment: Codex's is
             solid black, so it keeps a white plate to stay legible in dark
             mode. The slot is fixed at the glyph column's width either way, so
             both labels land where Files and Terminal's do. -->
        <span
          class="flex size-4 shrink-0 items-center justify-center text-(--solus-accent) {row.provider ===
          'codex'
            ? 'rounded-full bg-white'
            : ''}"
        >
          {#if row.provider === "claude-code"}
            <ClaudeIcon size={16} />
          {:else if row.provider === "codex"}
            <OpenAIBlossom size={14} />
          {:else if row.provider === "antigravity"}
            <ProviderMark mark="antigravity" size={16} transparent />
          {:else}
            <CodeIcon size={16} />
          {/if}
        </span>
        <span class="min-w-0 flex-1 truncate">{row.label}</span>
      </button>
      {#if row.groups}
        <div class="pr-2 pb-1 pl-8">
          {#if row.groups.checkedAt}
            <p class="pb-1 text-chrome-dense text-(--solus-text-tertiary)">Last known limits · {row.groups.checkedAt}</p>
          {/if}
          {#if row.groups.selected}
            <div class="text-chrome-dense font-medium text-(--solus-text-secondary)">{row.groups.selected.label}</div>
            {@render windowMeters(row.groups.selected.meters)}
          {/if}
          {#if row.groups.other.length > 0}
            <button
              type="button"
              aria-expanded={groupsExpanded}
              onclick={toggleGroups}
              class="-ml-1 flex min-h-6 items-center gap-1 rounded-sm px-1 text-chrome-dense text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) focus-visible:outline focus-visible:outline-(--solus-accent)"
            >
              <ChevronRightIcon size={12} class={groupsExpanded ? "rotate-90" : ""} />
              {row.groups.selected ? "Other model groups" : "View quota groups"}
            </button>
            {#if groupsExpanded}
              <div class="mt-1 border-t border-(--solus-surface-hover) pt-1">
                {#each row.groups.other as group (group.id)}
                  <div class="text-chrome-dense font-medium text-(--solus-text-secondary)">{group.label}</div>
                  {@render windowMeters(group.meters)}
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      {:else}
        <div class="pr-2 pl-8" class:opacity-60={row.stale}>
          {@render windowMeters(row.meters)}
        </div>
      {/if}
    {/each}
  </div>
{/if}
