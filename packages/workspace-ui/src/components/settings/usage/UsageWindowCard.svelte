<script lang="ts">
  import {
    formatCheckedAt,
    formatExactResetTime,
    formatUsagePercent,
    paceLabel,
    type UsageDisplayMode,
    type UsagePoolMember,
    type UsagePoolWindow,
  } from "@solus/client-core/usage-limits";
  import { RotateCw as RotateCwIcon } from "@lucide/svelte";
  import {
    formatShortResetClock,
    usageBarColor,
    usagePaceTextClass,
    usageWindowSubtitle,
  } from "./lib/usage-chart";
  import UsageAccountEmail from "./UsageAccountEmail.svelte";
  import UsageCallout from "./UsageCallout.svelte";
  import UsagePoolChart from "./UsagePoolChart.svelte";
  import UsageQuotaChart from "./UsageQuotaChart.svelte";
  import UsageResetTimer from "./UsageResetTimer.svelte";

  interface Props {
    window: UsagePoolWindow;
    providerLabel: string;
    displayMode: UsageDisplayMode;
    showHostNames: boolean;
    /** True when the parent harness header already shows this account's name/plan/email. */
    hideSingleAccountMeta?: boolean;
  }

  let {
    window,
    providerLabel,
    displayMode,
    showHostNames,
    hideSingleAccountMeta = false,
  }: Props = $props();

  let selectedAccountKey = $state<string | null>(null);

  const isPooled = $derived(window.members.length > 1);
  const singleMember = $derived(window.members.length === 1 ? window.members[0] : null);
  const selectedMember = $derived(
    selectedAccountKey
      ? window.members.find((member) => member.account.key === selectedAccountKey) ?? null
      : null,
  );
  const poolDisplay = $derived(
    formatUsagePercent(window.remainingPercent, window.usedPercent, displayMode),
  );
  const subtitle = $derived(usageWindowSubtitle(window, isPooled));

  function memberAriaLabel(member: UsagePoolMember): string {
    const pct = formatUsagePercent(
      member.window.remainingPercent,
      member.window.usedPercent,
      displayMode,
    );
    const parts = [
      `${providerLabel}, ${window.groupLabel ? `${window.groupLabel} ` : ""}${window.label}`,
      member.account.displayName,
      `${pct.formatted}${pct.suffix}`,
    ];
    const pacePct =
      displayMode === "used" ? member.window.paceUsedPercent : member.window.paceRemainingPercent;
    if (pacePct !== null) {
      parts.push(
        displayMode === "used"
          ? `${pacePct}% of the window elapsed`
          : `${pacePct}% of the window left`,
      );
    }
    if (member.window.resetCountdown) parts.push(member.window.resetCountdown);
    return parts.join(", ");
  }

  function toggleAccount(key: string) {
    selectedAccountKey = selectedAccountKey === key ? null : key;
  }
</script>

{#if !isPooled && singleMember}
  {@const member = singleMember}
  {@const display = formatUsagePercent(
    member.window.remainingPercent,
    member.window.usedPercent,
    displayMode,
  )}
  {@const pacePos =
    displayMode === "used" ? member.window.paceUsedPercent : member.window.paceRemainingPercent}
  {@const shortReset = formatShortResetClock(member.window.resetsAt)}
  {@const exactReset = formatExactResetTime(member.window.resetsAt)}
  {@const checkedAt = member.account.stale ? formatCheckedAt(member.account.fetchedAt) : null}
  {@const barColor = usageBarColor(member.window.tone, member.account.provider)}
  {@const isSpent = member.window.tone === "spent" || member.window.suppressedByWeekly}
  {@const resetText = member.window.resetCountdown
    ? shortReset
      ? `${member.window.resetCountdown} · ${shortReset}`
      : member.window.resetCountdown
    : shortReset
      ? `resets ${shortReset}`
      : null}

  <div
    class="flex flex-col gap-3 @min-[36rem]/pane:flex-row @min-[36rem]/pane:items-center @min-[36rem]/pane:gap-7 {member.account.stale ? 'opacity-65' : ''}"
  >
    <!-- Editorial metric column -->
    <div class="flex shrink-0 flex-col gap-0.5 @min-[36rem]/pane:w-37">
      <span class="text-xs font-medium text-muted-foreground">{subtitle}</span>
      <div class="flex items-baseline gap-1.5">
        <span
          class="text-[30px] leading-[34px] font-semibold tracking-[-0.03em] tabular-nums {isSpent ? 'text-(--solus-art-negative)' : 'text-foreground'}"
        >
          {display.formatted}%
        </span>
        <span class="text-[13px] text-muted-foreground">
          {displayMode === "used" ? "used" : "left"}
        </span>
      </div>
      {#if member.window.suppressedByWeekly}
        <span class="text-xs font-medium text-(--solus-art-negative)">Blocked by weekly limit</span>
      {:else if member.window.pace}
        <span class="text-xs {usagePaceTextClass(member.window.pace, false)}">
          {paceLabel(member.window.pace)}
        </span>
      {:else if checkedAt}
        <span class="text-xs text-muted-foreground">Last known · {checkedAt}</span>
      {/if}
    </div>

    <!-- LayerChart horizontal gauge + metadata -->
    <div class="flex min-w-0 flex-1 flex-col gap-2">
      {#if !hideSingleAccountMeta}
        <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {#if member.account.displayName !== member.account.providerLabel}
            <span class="font-medium text-foreground">{member.account.displayName}</span>
          {/if}
          {#if member.account.planType}
            <span class="rounded-full border border-border px-1.5 py-px text-[11px]">
              {member.account.planType}
            </span>
          {/if}
          {#if member.account.email}
            <UsageAccountEmail email={member.account.email} />
          {/if}
          {#if showHostNames && member.account.hosts.length > 0}
            <span>· {member.account.hosts.map((host) => host.label).join(", ")}</span>
          {/if}
        </div>
      {/if}

      <UsageQuotaChart
        barPercent={display.barPercent}
        pacePercent={pacePos}
        fillColor={barColor}
        spent={isSpent}
        {displayMode}
        valueLabel="{display.formatted}{display.suffix}"
        ariaLabel={memberAriaLabel(member)}
        ariaValueNow={display.value}
        resetSummary={resetText}
      />

      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span class="text-muted-foreground">
          {#if pacePos !== null}
            Even pace target:
            <span class="font-medium tabular-nums text-foreground/80">
              {pacePos}% {displayMode === "used" ? "used" : "left"}
            </span>
          {:else if checkedAt}
            Last known limits ({checkedAt})
          {/if}
        </span>
        {#if member.window.resetsAt !== null || member.window.resetsLabel}
          <span
            class="text-xs tabular-nums text-foreground/80"
            title={exactReset ? `Resets ${exactReset}` : undefined}
          >
            <UsageResetTimer
              resetsAt={member.window.resetsAt}
              resetsLabel={member.window.resetsLabel}
            />{#if shortReset}
              <span class="text-muted-foreground">{" · "}{shortReset}</span>
            {/if}
          </span>
        {/if}
      </div>
    </div>
  </div>
{:else if isPooled}
  <!-- Pooled multi-account row: left editorial total + right LayerChart segmented bar + unboxed INFO callout -->
  <div class="flex flex-col gap-3">
    <div class="flex flex-col gap-3 @min-[36rem]/pane:flex-row @min-[36rem]/pane:items-center @min-[36rem]/pane:gap-7">
      <div class="flex shrink-0 flex-col gap-0.5 @min-[36rem]/pane:w-37">
        <span class="text-xs font-medium text-muted-foreground">{subtitle}</span>
        <div class="flex items-baseline gap-1.5">
          <span
            class="text-[30px] leading-[34px] font-semibold tracking-[-0.03em] tabular-nums {window.tone === 'spent' ? 'text-(--solus-art-negative)' : 'text-foreground'}"
          >
            {poolDisplay.formatted}%
          </span>
          <span class="text-[13px] text-muted-foreground">
            {displayMode === "used" ? "used" : "left"}
          </span>
        </div>
        {#if window.pace}
          <span class="text-xs {usagePaceTextClass(window.pace, false)}">
            {paceLabel(window.pace)}
          </span>
        {/if}
      </div>

      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <UsagePoolChart
          {window}
          {providerLabel}
          {displayMode}
          {selectedAccountKey}
          onSelectAccount={toggleAccount}
        />

        <!-- Narrow-pane compact account rows so small containers always expose every account name and reset. -->
        <div class="flex flex-col divide-y divide-border/40 @min-[42rem]/pane:hidden">
          {#each window.members as member (member.account.key)}
            {@const display = formatUsagePercent(
              member.window.remainingPercent,
              member.window.usedPercent,
              displayMode,
            )}
            <button
              type="button"
              onclick={() => toggleAccount(member.account.key)}
              aria-expanded={selectedAccountKey === member.account.key}
              class="flex min-h-8 w-full cursor-pointer items-center justify-between gap-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span class="min-w-0 flex-1 truncate font-medium text-foreground">
                {member.account.displayName}
                {#if member.account.planType}
                  <span class="font-normal text-muted-foreground"> · {member.account.planType}</span>
                {/if}
              </span>
              <span class="shrink-0 font-semibold tabular-nums text-foreground">
                {display.formatted}%
              </span>
              {#if member.window.resetsAt !== null || member.window.resetsLabel}
                <span class="inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums">
                  <RotateCwIcon size={10} />
                  <UsageResetTimer
                    resetsAt={member.window.resetsAt}
                    resetsLabel={member.window.resetsLabel}
                    compact
                  />
                </span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    </div>

    {#if selectedMember}
      {@const shortReset = formatShortResetClock(selectedMember.window.resetsAt)}
      {@const exactReset = formatExactResetTime(selectedMember.window.resetsAt)}
      {@const checkedAt = formatCheckedAt(selectedMember.account.fetchedAt)}
      {@const totalWeight = window.members.reduce((sum, item) => sum + item.weight, 0)}
      {@const restoresPool = Math.round(
        (selectedMember.window.refillPercent * selectedMember.weight) / totalWeight,
      )}
      {@const evenPace =
        displayMode === "used"
          ? selectedMember.window.paceUsedPercent
          : selectedMember.window.paceRemainingPercent}
      <div class="@min-[36rem]/pane:ml-44">
        <UsageCallout kind="info">
          {#snippet children()}
            <div class="flex flex-col gap-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-semibold text-foreground">{selectedMember.account.displayName}</span>
                {#if selectedMember.account.planType}
                  <span class="rounded-full border border-border px-1.5 py-px text-[11px] text-muted-foreground">
                    {selectedMember.account.planType}
                  </span>
                {/if}
                {#if selectedMember.account.email}
                  <UsageAccountEmail email={selectedMember.account.email} />
                {/if}
              </div>
              <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {#if shortReset || exactReset}
                  <span class="tabular-nums" title={exactReset ?? undefined}>
                    Resets {shortReset ?? exactReset}
                  </span>
                {/if}
                {#if restoresPool > 0 && selectedMember.window.resetsAt}
                  <span>
                    · Restores
                    <span class="font-semibold tabular-nums text-(--solus-art-positive)">
                      +{restoresPool}%
                    </span>
                    of pool
                  </span>
                {/if}
                {#if evenPace !== null}
                  <span class="tabular-nums">
                    · Even pace {evenPace}% {displayMode === "used" ? "used" : "left"}
                  </span>
                {/if}
                {#if selectedMember.window.suppressedByWeekly}
                  <span class="font-medium text-(--solus-art-negative)">· Blocked by weekly limit</span>
                {/if}
                {#if showHostNames && selectedMember.account.hosts.length > 0}
                  <span>· Signed in on {selectedMember.account.hosts.map((host) => host.label).join(", ")}</span>
                {/if}
                {#if checkedAt && selectedMember.account.stale}
                  <span>· Last known {checkedAt}</span>
                {/if}
              </div>
            </div>
          {/snippet}
          {#snippet action()}
            <button
              type="button"
              onclick={() => (selectedAccountKey = null)}
              class="cursor-pointer rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              Hide
            </button>
          {/snippet}
        </UsageCallout>
      </div>
    {/if}
  </div>
{/if}
