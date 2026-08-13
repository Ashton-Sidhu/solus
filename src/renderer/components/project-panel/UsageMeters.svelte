<script lang="ts">
  import { CodeIcon } from "phosphor-svelte";
  import { Progress } from "@renderer/components/ui/progress";
  import { getAgentContext } from "../../contexts";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";
  import { providerUsage } from "./lib/usage-meters";

  interface Props {
    /** The panel is mounted for every tab; only the visible one asks for a
     *  refresh, and the backend's poll suspends when nobody is watching. */
    active?: boolean;
  }
  let { active = true }: Props = $props();

  const agent = getAgentContext();
  const rows = $derived(providerUsage(agent.agents, agent.usage, Date.now()));

  $effect(() => {
    if (!active) return;
    void agent.refreshUsage();
  });

  const barTone = {
    ok: "[&_[data-slot=progress-indicator]]:bg-(--solus-status-complete)",
    low: "[&_[data-slot=progress-indicator]]:bg-(--solus-status-running)",
    spent: "[&_[data-slot=progress-indicator]]:bg-(--solus-status-error)",
  } satisfies Record<string, string>;
</script>

{#if rows.length > 0}
  <div class="flex flex-col" class:opacity-60={rows.every((row) => row.stale)}>
    {#each rows as row (row.provider)}
      <!-- The provider reads as a menu row — same glyph column, same size and
           weight as Files and Terminal — and its windows hang beneath it. -->
      <div
        class="flex min-h-8 items-center gap-2 px-2 py-[0.3125rem] text-xs text-(--solus-text-secondary)"
      >
        <!-- Same marks as the model picker, in the same treatment: Codex's is
             solid black, so it keeps a white plate to stay legible in dark
             mode. The slot is fixed at the glyph column's width either way, so
             both labels land where Files and Terminal's do. -->
        <span
          class="flex size-[0.8125rem] shrink-0 items-center justify-center text-(--solus-accent) {row.provider ===
          'codex'
            ? 'rounded-full bg-white'
            : ''}"
        >
          {#if row.provider === "claude-code"}
            <ClaudeIcon size={13} />
          {:else if row.provider === "codex"}
            <OpenAIBlossom size={11} />
          {:else}
            <CodeIcon size={13} />
          {/if}
        </span>
        <span class="min-w-0 flex-1 truncate">{row.label}</span>
      </div>
      <div class="flex flex-col gap-1.5 pt-0.5 pr-2 pb-1.5 pl-[1.8125rem]">
        {#each row.meters as meter (meter.key)}
          <div class="flex flex-col gap-[0.1875rem]">
            <!-- The window and what's left of it read as one phrase; when it
                 refills is the qualifier, so it sits out at the right. -->
            <div class="flex items-baseline gap-1.5 text-menu-meta">
              <span class="shrink-0 text-(--solus-text-secondary)"
                >{meter.label}</span
              >
              <span
                class="order-last ml-auto shrink-0 tabular-nums text-(--solus-text-tertiary)"
                >{Math.round(meter.remainingPercent)}%</span
              >
              {#if meter.resetText}
                <span class="truncate text-(--solus-text-tertiary)"
                  >resets in {meter.resetText}</span
                >
              {/if}
            </div>
            <Progress
              value={meter.remainingPercent}
              class="h-[0.1875rem] bg-(--solus-surface-hover) {barTone[
                meter.tone
              ]}"
            />
          </div>
        {/each}
      </div>
    {/each}
  </div>
{/if}
