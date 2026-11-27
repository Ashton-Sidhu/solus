<script lang="ts">
  import {
    formatExactResetTime,
    formatUsagePercent,
    paceLabel,
    type UsageDisplayMode,
    type UsageModelGroupSection,
  } from "@solus/client-core/usage-limits";
  import { formatShortResetClock, usageBarColor, usagePaceTextClass } from "./lib/usage-chart";
  import UsageQuotaChart from "./UsageQuotaChart.svelte";
  import UsageResetTimer from "./UsageResetTimer.svelte";

  interface Props {
    section: UsageModelGroupSection;
    providerLabel: string;
    displayMode: UsageDisplayMode;
  }

  let { section, providerLabel, displayMode }: Props = $props();

  const primaryWindow = $derived(
    section.windows.find((candidate) => candidate.kind === "session") ?? section.windows[0] ?? null,
  );
  const secondaryWindows = $derived(
    section.windows.filter((candidate) => candidate.id !== primaryWindow?.id),
  );
</script>

{#if primaryWindow}
  {@const member = primaryWindow.members[0]}
  {@const display = formatUsagePercent(
    primaryWindow.remainingPercent,
    primaryWindow.usedPercent,
    displayMode,
  )}
  {@const pacePos =
    displayMode === "used" ? primaryWindow.paceUsedPercent : primaryWindow.paceRemainingPercent}
  {@const suppressed = Boolean(member?.window.suppressedByWeekly)}
  {@const isSpent = primaryWindow.tone === "spent" || suppressed}
  {@const barColor = usageBarColor(primaryWindow.tone, member?.account.provider ?? "antigravity")}
  {@const shortReset = formatShortResetClock(member?.window.resetsAt ?? null)}
  {@const exactReset = formatExactResetTime(member?.window.resetsAt ?? null)}
  {@const countdown = member?.window.resetCountdown
    ? suppressed && member.window.resetCompact
      ? `reopens in ${member.window.resetCompact}`
      : member.window.resetCountdown
    : null}

  <div class="flex min-w-0 flex-col gap-3">
    <div class="flex items-baseline justify-between gap-2">
      <span class="truncate text-[13px] font-semibold text-foreground">
        {section.groupLabel ?? primaryWindow.label}
      </span>
      {#if suppressed}
        <span class="shrink-0 text-xs font-medium text-(--solus-art-negative)">
          Blocked by weekly limit
        </span>
      {:else if primaryWindow.pace}
        <span class="shrink-0 text-xs {usagePaceTextClass(primaryWindow.pace, false)}">
          {paceLabel(primaryWindow.pace)}
        </span>
      {/if}
    </div>

    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div class="flex items-baseline gap-1.5">
        <span
          class="text-[26px] leading-[30px] font-semibold tracking-[-0.025em] tabular-nums {isSpent ? 'text-(--solus-art-negative)' : 'text-foreground'}"
        >
          {display.formatted}%
        </span>
        <span class="text-xs text-muted-foreground">
          {#if suppressed && displayMode === "remaining"}
            session available
          {:else}
            {primaryWindow.label.toLowerCase()} {displayMode === "used" ? "used" : "left"}
          {/if}
        </span>
      </div>
      {#if member && (member.window.resetsAt !== null || member.window.resetsLabel)}
        <UsageResetTimer
          resetsAt={member.window.resetsAt}
          resetsLabel={member.window.resetsLabel}
          verb={suppressed ? "reopens" : "resets"}
          class="text-xs text-muted-foreground"
          title={exactReset ? `Resets ${exactReset}` : undefined}
        />
      {/if}
    </div>

    <UsageQuotaChart
      barPercent={display.barPercent}
      pacePercent={pacePos}
      fillColor={barColor}
      spent={isSpent}
      compact
      {displayMode}
      valueLabel="{display.formatted}{display.suffix}"
      ariaLabel="{providerLabel}, {section.groupLabel ?? primaryWindow.label}, {display.formatted}{display.suffix}"
      ariaValueNow={display.value}
      resetSummary={countdown ? (shortReset ? `${countdown} · ${shortReset}` : countdown) : null}
    />

    {#each secondaryWindows as extra (extra.id)}
      {@const extraDisplay = formatUsagePercent(
        extra.remainingPercent,
        extra.usedPercent,
        displayMode,
      )}
      {@const extraMember = extra.members[0]}
      {@const extraShort = formatShortResetClock(extraMember?.window.resetsAt ?? null)}
      {@const extraSpent = extra.tone === "spent"}
      <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span class="text-muted-foreground">{extra.label}</span>
        <span
          class="font-medium tabular-nums {extraSpent ? 'text-(--solus-art-negative)' : 'text-foreground/80'}"
        >
          {extraDisplay.formatted}{extraDisplay.suffix}{#if extraSpent && extraShort}
            {" · "}{extraShort}
          {:else if extraMember && (extraMember.window.resetsAt !== null || extraMember.window.resetsLabel)}
            {" · "}<UsageResetTimer
              resetsAt={extraMember.window.resetsAt}
              resetsLabel={extraMember.window.resetsLabel}
            />
          {/if}
        </span>
      </div>
    {/each}
  </div>
{/if}
