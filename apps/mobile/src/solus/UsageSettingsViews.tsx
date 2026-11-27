import { useEffect, useId, useState } from "react";
import { Pressable, View } from "react-native";
import { Defs, Path, Pattern, Rect, Svg } from "react-native-svg";
import { useIsFocused } from "@react-navigation/native";
import {
  emailInitials,
  formatExactResetTime,
  formatLiveResetCountdown,
  formatUsagePercent,
  groupUsageWindowsByModelGroup,
  paceLabel,
  unsupportedAccountOf,
  usageUnsupportedMessage,
  type UsageAccountEntry,
  type UsageDisplayMode,
  type UsageModelGroupSection,
  type UsageNextRefill,
  type UsageOverview,
  type UsagePace,
  type UsagePoolWindow,
  type UsageProviderGroup,
  type UsageTone,
} from "@solus/client-core/usage-limits";
import { AppText as Text } from "../components/ui/AppText";
import { ProviderIcon } from "../components/ProviderIcon";
import { useProviderColors } from "../features/usage/usageProviders";

export function t3DriverFor(provider: string): string {
  return provider === "claude-code" ? "claudeAgent" : provider;
}

function useBarColor(provider: string, tone: UsageTone): string {
  const colors = useProviderColors();
  if (tone === "spent") return "#c9302d";
  if (tone === "low") return "#d18a06";
  if (provider === "claude-code") return colors.claude;
  if (provider === "codex") return colors.codex;
  if (provider === "antigravity") return "#26894c";
  return colors.codex;
}

function paceColorClass(pace: UsagePace | null, suppressed: boolean): string {
  if (suppressed) return "text-destructive font-t3-medium";
  if (pace === "ahead") return "text-amber-600 dark:text-amber-400 font-t3-medium";
  if (pace === "under") return "text-emerald-600 dark:text-emerald-400";
  return "text-foreground-muted";
}

function LiveResetText({
  resetsAt,
  resetsLabel = null,
  verb = "resets",
  compact = false,
  className,
}: {
  readonly resetsAt: number | null;
  readonly resetsLabel?: string | null;
  readonly verb?: string;
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const isFocused = useIsFocused();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isFocused || resetsAt === null || !Number.isFinite(resetsAt)) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [isFocused, resetsAt]);

  const text = formatLiveResetCountdown(resetsAt, resetsLabel, now, { verb, compact });
  if (!text) return null;
  return (
    <Text className={className ? `tabular-nums ${className}` : "tabular-nums"} numberOfLines={1}>
      {text}
    </Text>
  );
}

export function MobileCallout({
  kind,
  label,
  actionLabel,
  onAction,
  actionDisabled = false,
  children,
}: {
  readonly kind: "info" | "note" | "warning";
  readonly label?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly actionDisabled?: boolean;
  readonly children: React.ReactNode;
}) {
  const topBorder =
    kind === "warning"
      ? "border-t-amber-500/50"
      : "border-t-blue-600/40 dark:border-t-blue-400/40";
  const labelColor =
    kind === "warning"
      ? "text-amber-700 dark:text-amber-400"
      : "text-blue-700 dark:text-blue-400";
  const heading = label ?? (kind === "warning" ? "WARNING" : kind === "info" ? "INFO" : "NOTE");

  return (
    <View
      accessible
      accessibilityRole={kind === "warning" ? "alert" : "text"}
      accessibilityLiveRegion={kind === "warning" ? "polite" : "none"}
      className={`gap-1 border-t border-b border-b-border-subtle py-3 ${topBorder}`}
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text className={`font-mono text-[10px] font-t3-medium tracking-widest uppercase ${labelColor}`}>
          {heading}
        </Text>
        {actionLabel && onAction ? (
          <Pressable
            accessibilityRole="button"
            disabled={actionDisabled}
            onPress={onAction}
            className="active:opacity-60"
          >
            <Text className="text-xs font-t3-medium text-foreground">{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
      <View className="gap-0.5">{children}</View>
    </View>
  );
}

function PaceBar({
  barPercent,
  pacePercent,
  color,
  spent = false,
}: {
  readonly barPercent: number;
  readonly pacePercent: number | null;
  readonly color: string;
  readonly spent?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const clamped = Math.max(0, Math.min(100, barPercent));
  const tickX =
    pacePercent === null || width < 6
      ? null
      : Math.min(Math.max((width * pacePercent) / 100, 3), width - 3);
  const trackBgClass = spent ? "bg-destructive/15" : "bg-subtle";
  const track = (
    <View
      className={`h-2 flex-row overflow-hidden rounded-full ${trackBgClass}`}
      style={width > 0 ? { width } : undefined}
    >
      {clamped > 0 ? (
        <View
          className="h-full rounded-full"
          style={{ flex: clamped, backgroundColor: color }}
        />
      ) : null}
      <View style={{ flex: 100 - clamped }} />
    </View>
  );
  return (
    <View
      className="h-3.5 justify-center"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {tickX === null ? (
        track
      ) : (
        <View className="h-2">
          {(
            [
              [0, tickX - 3],
              [tickX + 3, width],
            ] as const
          ).map(([start, end]) => (
            <View
              key={start}
              className="absolute top-0 bottom-0 overflow-hidden"
              style={{ left: start, width: Math.max(0, end - start) }}
            >
              <View style={{ marginLeft: -start }}>{track}</View>
            </View>
          ))}
        </View>
      )}
      {tickX !== null ? (
        <View
          className="absolute top-px bottom-px w-0.5 rounded-full bg-foreground"
          style={{ left: tickX - 1 }}
        />
      ) : null}
    </View>
  );
}

function HatchedSegment({
  barPercent,
  refillPercent,
  color,
}: {
  readonly barPercent: number;
  readonly refillPercent: number;
  readonly color: string;
}) {
  const patternId = useId().replace(/:/g, "");
  const [size, setSize] = useState({ width: 0, height: 0 });
  return (
    <View
      pointerEvents="none"
      className="absolute inset-0"
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      }}
    >
      {size.width > 0 && size.height > 0 ? (
        <Svg width={size.width} height={size.height} accessible={false}>
          <Defs>
            <Pattern id={patternId} width={6} height={6} patternUnits="userSpaceOnUse">
              <Path d="M-1 1L1 -1M0 6L6 0M5 7L7 5" stroke={color} strokeWidth={1} opacity={0.22} />
            </Pattern>
          </Defs>
          {refillPercent > 0 ? (
            <Rect
              x={`${100 - Math.min(100 - barPercent, refillPercent)}%`}
              width={`${Math.min(100 - barPercent, refillPercent)}%`}
              height="100%"
              fill={`url(#${patternId})`}
            />
          ) : null}
          {barPercent > 0 ? (
            <Rect width={`${barPercent}%`} height="100%" fill={color} opacity={0.28} />
          ) : null}
        </Svg>
      ) : null}
    </View>
  );
}

function SingleUsageWindowRow({
  window,
  secondaryWindows,
  providerLabel,
  displayMode,
  color,
  onSelectAccount,
}: {
  readonly window: UsagePoolWindow;
  readonly secondaryWindows: readonly UsagePoolWindow[];
  readonly providerLabel: string;
  readonly displayMode: UsageDisplayMode;
  readonly color: string;
  readonly onSelectAccount: (account: UsageAccountEntry) => void;
}) {
  const first = window.members[0]!;
  const display = formatUsagePercent(first.window.remainingPercent, first.window.usedPercent, displayMode);
  const pacePos = displayMode === "used" ? first.window.paceUsedPercent : first.window.paceRemainingPercent;
  const isSpent = first.window.tone === "spent" || first.window.suppressedByWeekly;
  const accessLabel = [
    `${providerLabel}, ${window.groupLabel ? `${window.groupLabel} ` : ""}${window.label}`,
    `${display.formatted}${display.suffix}`,
    first.window.resetCountdown,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessLabel}
      accessibilityHint="Show account details"
      onPress={() => onSelectAccount(first.account)}
      className={`gap-2.5 active:opacity-70 ${first.account.stale ? "opacity-65" : ""}`}
    >
      <View className="flex-row items-baseline justify-between gap-2">
        <View className="flex-row items-baseline gap-1.5">
          <Text
            className={`text-[28px] leading-[32px] font-t3-semibold tracking-tight tabular-nums ${isSpent ? "text-destructive" : "text-foreground"}`}
          >
            {display.formatted}%
          </Text>
          <Text className="text-xs text-foreground-tertiary">
            {window.label.toLowerCase()} {displayMode === "used" ? "used" : "left"}
          </Text>
        </View>
        {first.window.resetsAt !== null || first.window.resetsLabel ? (
          <LiveResetText
            resetsAt={first.window.resetsAt}
            resetsLabel={first.window.resetsLabel}
            className="text-xs text-foreground-muted"
          />
        ) : null}
      </View>

      <PaceBar barPercent={display.barPercent} pacePercent={pacePos} color={color} spent={isSpent} />

      {secondaryWindows.map((extra) => {
        const extraMember = extra.members[0];
        const extraDisplay = formatUsagePercent(extra.remainingPercent, extra.usedPercent, displayMode);
        return (
          <View key={extra.id} className="flex-row items-center justify-between gap-2 pt-0.5">
            <View className="flex-row items-center gap-1">
              <Text className="text-xs text-foreground-tertiary">{extra.label}</Text>
              {extra.pace ? (
                <Text className={`text-xs ${paceColorClass(extra.pace, false)}`}>
                  · {paceLabel(extra.pace)}
                </Text>
              ) : null}
            </View>
            <View className="flex-row items-center gap-1">
              <Text className="text-xs font-t3-semibold tabular-nums text-foreground">
                {extraDisplay.formatted}%
              </Text>
              {extraMember && (extraMember.window.resetsAt !== null || extraMember.window.resetsLabel) ? (
                <>
                  <Text className="text-xs text-foreground-muted">·</Text>
                  <LiveResetText
                    resetsAt={extraMember.window.resetsAt}
                    resetsLabel={extraMember.window.resetsLabel}
                    compact
                    className="text-xs text-foreground-muted"
                  />
                </>
              ) : null}
            </View>
          </View>
        );
      })}
    </Pressable>
  );
}

function PooledUsageWindowRow({
  window,
  displayMode,
  showHosts,
  color,
  onSelectAccount,
}: {
  readonly window: UsagePoolWindow;
  readonly displayMode: UsageDisplayMode;
  readonly showHosts: boolean;
  readonly color: string;
  readonly onSelectAccount: (account: UsageAccountEntry) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const poolDisplay = formatUsagePercent(window.remainingPercent, window.usedPercent, displayMode);
  const selectedMember = selectedKey
    ? window.members.find((member) => member.account.key === selectedKey) ?? null
    : null;
  const totalWeight = window.members.reduce((sum, item) => sum + item.weight, 0);

  return (
    <View className="gap-3">
      <View className="flex-row items-baseline gap-1.5">
        <Text className="text-[28px] leading-[32px] font-t3-semibold tracking-tight tabular-nums text-foreground">
          {poolDisplay.formatted}%
        </Text>
        <Text className="text-xs text-foreground-tertiary">
          {displayMode === "used" ? "used" : "left"}
          {window.pace ? ` · ${paceLabel(window.pace)}` : ""}
        </Text>
      </View>

      <View className="flex-row gap-1.5">
        {window.members.map((member, index) => {
          const display = formatUsagePercent(member.window.remainingPercent, member.window.usedPercent, displayMode);
          const pacePos = displayMode === "used" ? member.window.paceUsedPercent : member.window.paceRemainingPercent;
          const refillPct =
            member.window.resetsAt && displayMode === "remaining" ? member.window.refillPercent : 0;
          const isSpent = member.window.tone === "spent";
          const isSelected = selectedKey === member.account.key;
          const share = member.weight / totalWeight;
          const initials = member.account.email ? emailInitials(member.account.email) : String(index + 1);
          const label =
            share < 0.3
              ? `${initials} · ${display.formatted}%`
              : `${member.account.displayName} · ${display.formatted}%`;
          return (
            <Pressable
              key={member.account.key}
              accessibilityRole="button"
              accessibilityLabel={`${member.account.displayName}, ${display.formatted}${display.suffix}`}
              accessibilityHint="Toggle account details"
              onPress={() =>
                setSelectedKey((current) => (current === member.account.key ? null : member.account.key))
              }
              style={{ flex: member.weight }}
              className={`h-9 min-w-0 overflow-hidden rounded-lg active:opacity-75 ${
                isSpent ? "bg-destructive/15" : "bg-subtle"
              } ${isSelected ? (isSpent ? "border border-destructive" : "border border-foreground") : ""}`}
            >
              <HatchedSegment barPercent={display.barPercent} refillPercent={refillPct} color={color} />
              {pacePos !== null ? (
                <View
                  pointerEvents="none"
                  className="absolute top-1 bottom-1 w-0.5 rounded-full bg-foreground"
                  style={{ left: `${Math.max(4, Math.min(96, pacePos))}%` }}
                />
              ) : null}
              <View className="flex-1 flex-row items-center justify-between px-2.5">
                <Text
                  className={`text-xs font-t3-semibold tabular-nums ${isSpent ? "text-destructive" : "text-foreground"}`}
                  numberOfLines={1}
                >
                  {label}
                </Text>
                {share >= 0.35 && (member.window.resetsAt !== null || member.window.resetsLabel) ? (
                  <LiveResetText
                    resetsAt={member.window.resetsAt}
                    resetsLabel={member.window.resetsLabel}
                    compact
                    className="text-[11px] text-foreground-muted"
                  />
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      {selectedMember ? (
        <MobileCallout
          kind="info"
          label={`INFO · ${selectedMember.account.displayName.toUpperCase()}`}
          actionLabel="Hide"
          onAction={() => setSelectedKey(null)}
        >
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
              {[
                selectedMember.account.planType,
                formatExactResetTime(selectedMember.window.resetsAt)
                  ? `resets ${formatExactResetTime(selectedMember.window.resetsAt)}`
                  : selectedMember.window.resetCountdown,
                selectedMember.window.resetsAt && selectedMember.window.refillPercent > 0
                  ? `restores +${Math.round((selectedMember.window.refillPercent * selectedMember.weight) / totalWeight)}% of pool`
                  : null,
                showHosts && selectedMember.account.hosts.length > 0
                  ? selectedMember.account.hosts.map((host) => host.label).join(", ")
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => onSelectAccount(selectedMember.account)}
              className="active:opacity-60"
            >
              <Text className="text-xs font-t3-medium text-foreground">Details</Text>
            </Pressable>
          </View>
        </MobileCallout>
      ) : null}
    </View>
  );
}

function UsageModelGroupRow({
  section,
  first,
  displayMode,
  onSelectAccount,
}: {
  readonly section: UsageModelGroupSection;
  readonly first: boolean;
  readonly displayMode: UsageDisplayMode;
  readonly onSelectAccount: (account: UsageAccountEntry) => void;
}) {
  const win =
    section.windows.find((candidate) => candidate.kind === "session") ?? section.windows[0];
  if (!win) return null;
  const member = win.members[0];
  const display = formatUsagePercent(win.remainingPercent, win.usedPercent, displayMode);
  const suppressed = Boolean(member?.window.suppressedByWeekly);
  const isSpent = win.tone === "spent" || suppressed;
  const toneClass = paceColorClass(win.pace, suppressed);
  const statusPrefix = suppressed ? "Blocked by weekly" : win.pace ? paceLabel(win.pace) : null;
  const reset = member && (member.window.resetsAt !== null || member.window.resetsLabel) ? member.window : null;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        if (member) onSelectAccount(member.account);
      }}
      className={`flex-row items-center justify-between gap-3 py-2.5 active:opacity-70 ${
        first ? "" : "border-t border-border-subtle"
      }`}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[13px] font-t3-medium text-foreground">
          {section.groupLabel ?? win.label}
        </Text>
        {statusPrefix || reset ? (
          <View className="flex-row flex-wrap items-center gap-1">
            {statusPrefix ? <Text className={`text-xs ${toneClass}`}>{statusPrefix}</Text> : null}
            {statusPrefix && reset ? <Text className={`text-xs ${toneClass}`}>·</Text> : null}
            {reset ? (
              <LiveResetText
                resetsAt={reset.resetsAt}
                resetsLabel={reset.resetsLabel}
                verb={suppressed ? "reopens" : "resets"}
                className={`text-xs ${toneClass}`}
              />
            ) : null}
          </View>
        ) : null}
      </View>
      <Text
        className={`text-base font-t3-semibold tabular-nums ${isSpent ? "text-destructive" : "text-foreground"}`}
      >
        {display.formatted}%
      </Text>
    </Pressable>
  );
}

function UsageModelGroupRows({
  sections,
  displayMode,
  onSelectAccount,
}: {
  readonly sections: readonly UsageModelGroupSection[];
  readonly displayMode: UsageDisplayMode;
  readonly onSelectAccount: (account: UsageAccountEntry) => void;
}) {
  return (
    <View>
      {sections.map((section, index) => (
        <UsageModelGroupRow
          key={section.groupId ?? index}
          section={section}
          first={index === 0}
          displayMode={displayMode}
          onSelectAccount={onSelectAccount}
        />
      ))}
    </View>
  );
}

function HarnessStatusLabel({
  refillBadge,
  blockedGroupCount,
  primaryWindow,
}: {
  readonly refillBadge: UsageNextRefill | null;
  readonly blockedGroupCount: number;
  readonly primaryWindow: UsagePoolWindow | null;
}) {
  if (refillBadge) {
    return (
      <View className="flex-row items-center gap-1">
        <Text className="text-[11px] font-t3-medium tabular-nums text-emerald-600 dark:text-emerald-400">
          ↻ +{refillBadge.restoresPercent}%
        </Text>
        <LiveResetText
          resetsAt={refillBadge.at}
          verb=""
          className="text-[11px] font-t3-medium text-emerald-600 dark:text-emerald-400"
        />
      </View>
    );
  }
  if (blockedGroupCount > 0) {
    return <Text className="text-xs font-t3-medium text-destructive">{blockedGroupCount} blocked</Text>;
  }
  if (primaryWindow?.members.length === 1 && primaryWindow.pace) {
    const suppressed = Boolean(primaryWindow.members[0]?.window.suppressedByWeekly);
    return (
      <Text className={`text-xs ${paceColorClass(primaryWindow.pace, suppressed)}`}>
        {suppressed ? "Blocked" : paceLabel(primaryWindow.pace)}
      </Text>
    );
  }
  return null;
}

function UnsupportedHarnessBlock({
  group,
  account,
  showHosts,
}: {
  readonly group: UsageProviderGroup;
  readonly account: UsageAccountEntry;
  readonly showHosts: boolean;
}) {
  return (
    <View className="gap-3 border-b border-border-subtle py-4.5">
      <View className="flex-row items-center gap-2">
        <ProviderIcon provider={t3DriverFor(group.provider)} size={18} />
        <Text className="text-[15px] font-t3-semibold text-foreground" numberOfLines={1}>
          {group.label}
        </Text>
        <View className="rounded-full border border-border-subtle px-2 py-px">
          <Text className="text-[11px] font-t3-medium text-foreground-muted">
            Unavailable
          </Text>
        </View>
      </View>

      <View className="gap-2">
        <View
          accessible={false}
          className="h-2 rounded-full border border-dashed border-border-subtle bg-subtle/50"
        />
        <Text className="text-xs text-foreground-muted">
          {usageUnsupportedMessage(group.provider)}
        </Text>
        {showHosts && account.hosts.length > 0 ? (
          <Text className="text-xs text-foreground-tertiary">
            {account.hosts.map((host) => host.label).join(", ")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function MeteredHarnessBlock({
  group,
  displayMode,
  showHosts,
  onSelectAccount,
}: {
  readonly group: UsageProviderGroup;
  readonly displayMode: UsageDisplayMode;
  readonly showHosts: boolean;
  readonly onSelectAccount: (account: UsageAccountEntry) => void;
}) {
  const windowGroups = groupUsageWindowsByModelGroup(group.windows);
  const hasModelGroups =
    windowGroups.length > 1 && windowGroups.every((section) => section.groupLabel !== null);
  const subscriptionAccounts = group.accounts.filter((account) => account.status === "subscription");
  const headerAccount = subscriptionAccounts.length === 1 ? subscriptionAccounts[0]! : null;
  const primaryWindow =
    group.windows.find((candidate) => candidate.kind === "session") ?? group.windows[0] ?? null;
  const secondaryWindows = primaryWindow
    ? group.windows.filter((candidate) => candidate.id !== primaryWindow.id)
    : [];
  const primaryColor = useBarColor(group.provider, primaryWindow?.tone ?? "ok");
  const refillBadge =
    group.windows.find((candidate) => candidate.members.length > 1 && candidate.nextRefill)
      ?.nextRefill ?? null;
  const blockedGroupCount = hasModelGroups
    ? windowGroups.filter((section) =>
        section.windows.some(
          (win) => win.tone === "spent" || win.members.some((member) => member.window.suppressedByWeekly),
        ),
      ).length
    : 0;

  return (
    <View className="gap-3 border-b border-border-subtle py-4.5">
      <View className="flex-row items-center justify-between gap-2">
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <ProviderIcon provider={t3DriverFor(group.provider)} size={18} />
          <Text className="text-[15px] font-t3-semibold text-foreground" numberOfLines={1}>
            {group.label}
          </Text>
          {subscriptionAccounts.length > 1 ? (
            <Text className="text-xs text-foreground-tertiary">
              {subscriptionAccounts.length} pooled
            </Text>
          ) : headerAccount?.planType ? (
            <View className="rounded-full border border-border-subtle px-2 py-px">
              <Text className="text-[11px] font-t3-medium text-foreground-muted">
                {headerAccount.planType}
              </Text>
            </View>
          ) : null}
        </View>
        <HarnessStatusLabel
          refillBadge={refillBadge}
          blockedGroupCount={blockedGroupCount}
          primaryWindow={primaryWindow}
        />
      </View>

      {hasModelGroups ? (
        <UsageModelGroupRows
          sections={windowGroups}
          displayMode={displayMode}
          onSelectAccount={onSelectAccount}
        />
      ) : primaryWindow ? (
        primaryWindow.members.length > 1 ? (
          <PooledUsageWindowRow
            window={primaryWindow}
            displayMode={displayMode}
            showHosts={showHosts}
            color={primaryColor}
            onSelectAccount={onSelectAccount}
          />
        ) : (
          <SingleUsageWindowRow
            window={primaryWindow}
            secondaryWindows={secondaryWindows}
            providerLabel={group.label}
            displayMode={displayMode}
            color={primaryColor}
            onSelectAccount={onSelectAccount}
          />
        )
      ) : null}
    </View>
  );
}

export function UsageHarnessBlock({
  group,
  displayMode,
  showHosts,
  onSelectAccount,
}: {
  readonly group: UsageProviderGroup;
  readonly displayMode: UsageDisplayMode;
  readonly showHosts: boolean;
  readonly onSelectAccount: (account: UsageAccountEntry) => void;
}) {
  const unsupportedAccount = group.windows.length === 0 ? unsupportedAccountOf(group) : null;
  if (unsupportedAccount) {
    return (
      <UnsupportedHarnessBlock
        group={group}
        account={unsupportedAccount}
        showHosts={showHosts}
      />
    );
  }
  return (
    <MeteredHarnessBlock
      group={group}
      displayMode={displayMode}
      showHosts={showHosts}
      onSelectAccount={onSelectAccount}
    />
  );
}

export function UsageNotices({
  rawOverview,
  nonMeteredAccounts,
  showHosts,
  refreshing,
  onRefresh,
  onSelectAccount,
}: {
  readonly rawOverview: UsageOverview;
  readonly nonMeteredAccounts: readonly UsageAccountEntry[];
  readonly showHosts: boolean;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onSelectAccount: (account: UsageAccountEntry) => void;
}) {
  if (
    rawOverview.failedHosts.length === 0 &&
    rawOverview.staleHosts.length === 0 &&
    nonMeteredAccounts.length === 0
  ) {
    return null;
  }

  return (
    <View className="pt-4">
      {rawOverview.failedHosts.map((failure) => (
        <MobileCallout
          key={failure.serverId}
          kind="warning"
          actionLabel="Retry"
          actionDisabled={refreshing}
          onAction={onRefresh}
        >
          <Text className="text-xs text-foreground-muted">
            <Text className="font-t3-medium text-foreground">{failure.label}: </Text>
            {failure.message}
          </Text>
        </MobileCallout>
      ))}

      {rawOverview.staleHosts.length > 0 ? (
        <MobileCallout
          kind="warning"
          actionLabel="Retry"
          actionDisabled={refreshing}
          onAction={onRefresh}
        >
          <Text className="text-xs text-foreground-muted">
            {rawOverview.staleHosts.join(", ")} could not refresh limits. Showing last known values.
          </Text>
        </MobileCallout>
      ) : null}

      {nonMeteredAccounts.map((account) => {
        const hostSuffix =
          showHosts && account.hosts.length > 0
            ? ` on ${account.hosts.map((host) => host.label).join(", ")}`
            : "";
        const statusText =
          account.status === "api"
            ? "uses metered API billing."
            : account.status === "signed_out"
              ? "is signed out."
              : "could not read subscription limits.";
        return (
          <MobileCallout
            key={account.key}
            kind={account.status === "unavailable" ? "warning" : "note"}
            actionLabel="Details"
            onAction={() => onSelectAccount(account)}
          >
            <Text className="text-xs text-foreground-muted">
              <Text className="font-t3-medium text-foreground">
                {account.displayName}
                {hostSuffix}
              </Text>{" "}
              {statusText}
            </Text>
          </MobileCallout>
        );
      })}
    </View>
  );
}
