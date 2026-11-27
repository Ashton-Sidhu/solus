import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import {
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { EnvironmentId } from "@t3tools/contracts";
import type { HostApi } from "@solus/client-core/host-api";
import type { AgentId, AgentUsageLimits } from "@solus/contracts/types";
import {
  buildUsageOverview,
  filterUsageOverview,
  formatCheckedAt,
  formatExactResetTime,
  hasUsageSectionContent,
  maskEmail,
  paceLabel,
  usageUnsupportedMessage,
  type HostUsageInput,
  type UsageAccountEntry,
  type UsageDisplayMode,
  type UsageOverview,
  type UsageStateFilter,
} from "@solus/client-core/usage-limits";
import type { AppBarMenu } from "../components/ui/AppBar.types";
import { AppText as Text } from "../components/ui/AppText";
import { ProviderIcon } from "../components/ProviderIcon";
import { RefreshControl } from "../components/ui/RefreshControl";
import { ScreenScrollView as ScrollView } from "../components/ui/ScreenScrollView";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { SettingsScreen } from "../features/settings/components/SettingsScreen";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { useSolusSettingsFilter } from "../features/settings/settings-environment-filter";
import { useSettingsEnvironmentMenu } from "../features/settings/components/SettingsEnvironmentFilterHeader";
import { useNowMinuteMs } from "../lib/clock";
import { SettingsPage } from "./SettingsPages";
import { Note, useSettingsAction } from "./SettingsFeedback";
import {
  MobileCallout,
  UsageHarnessBlock,
  UsageNotices,
  t3DriverFor,
} from "./UsageSettingsViews";
import { useHostSettingsRead } from "./use-host-settings-read";
import { solus, useSolusWorkspace } from "./runtime";

interface HostUsageState {
  readonly state: "loading" | "ready" | "error";
  readonly snapshots: readonly AgentUsageLimits[];
  readonly availableProviders?: readonly AgentId[];
  readonly error?: string;
}

function readAvailableProviders(hostId: string): readonly AgentId[] | undefined {
  const machine = solus.connections.connection(hostId)?.facts.value("machine");
  return machine?.agents.filter((agent) => agent.available !== false).map((agent) => agent.id);
}

const DISPLAY_OPTIONS = [
  { value: "remaining" as const, label: "Left" },
  { value: "used" as const, label: "Used" },
];

const STATE_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: UsageStateFilter;
  readonly label: string;
}> = [
  { value: "all", label: "All states" },
  { value: "issues", label: "Needs attention" },
  { value: "ahead", label: "Ahead of pace" },
  { value: "blocked", label: "Blocked or spent" },
  { value: "signed_out", label: "Signed out" },
];

function useMultiHostUsage(hostIds: readonly string[], active: boolean) {
  const [byHost, setByHost] = useState<Readonly<Record<string, HostUsageState>>>({});
  const [refreshing, setRefreshing] = useState(false);
  const hostIdsKey = hostIds.join("\u0000");
  const generationRef = useRef(0);

  const loadHost = useCallback(async (hostId: string, force: boolean, generation: number) => {
    const connection = solus.connections.connection(hostId);
    if (!connection || connection.state.readiness !== "ready") {
      setByHost((prev) => ({
        ...prev,
        [hostId]: { state: "error", snapshots: prev[hostId]?.snapshots ?? [], error: "Reconnect to this environment." },
      }));
      return;
    }
    try {
      const snapshots = force
        ? await connection.api.usageLimits({ force: true })
        : await connection.api.usageWatch().catch(() => connection.api.usageLimits());
      if (generationRef.current !== generation) return;
      const availableProviders = readAvailableProviders(hostId);
      setByHost((prev) => ({
        ...prev,
        [hostId]: {
          state: "ready",
          snapshots,
          availableProviders: availableProviders ?? prev[hostId]?.availableProviders,
        },
      }));
    } catch (error) {
      if (generationRef.current !== generation) return;
      setByHost((prev) => ({
        ...prev,
        [hostId]: {
          state: "error",
          snapshots: prev[hostId]?.snapshots ?? [],
          availableProviders: readAvailableProviders(hostId) ?? prev[hostId]?.availableProviders,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const generation = ++generationRef.current;
    const ids = hostIdsKey ? hostIdsKey.split("\u0000") : [];
    const stops: Array<() => void> = [];
    for (const hostId of ids) {
      const connection = solus.connections.connection(hostId);
      if (connection) {
        connection.facts.ensure("machine");
        stops.push(
          connection.facts.subscribe((key) => {
            if (key !== "machine" || generationRef.current !== generation) return;
            const availableProviders = readAvailableProviders(hostId);
            setByHost((prev) => {
              const current = prev[hostId];
              if (!current) return prev;
              return { ...prev, [hostId]: { ...current, availableProviders } };
            });
          }),
        );
        stops.push(
          connection.events.subscribe("usage.limitsChanged", ({ snapshots }) => {
            if (generationRef.current !== generation) return;
            const availableProviders = readAvailableProviders(hostId);
            setByHost((prev) => ({
              ...prev,
              [hostId]: {
                state: "ready",
                snapshots,
                availableProviders: availableProviders ?? prev[hostId]?.availableProviders,
              },
            }));
          }),
        );
        stops.push(
          connection.events.subscribe("provider-instances.changed", () => {
            void loadHost(hostId, true, generation);
          }),
        );
      }
      void loadHost(hostId, false, generation);
    }
    return () => {
      generationRef.current += 1;
      for (const stop of stops) stop();
      for (const hostId of ids) {
        void solus.connections.connection(hostId)?.api.usageUnwatch().catch(() => {});
      }
    };
  }, [active, hostIdsKey, loadHost]);

  const refresh = useCallback(async () => {
    const ids = hostIdsKey ? hostIdsKey.split("\u0000") : [];
    const generation = generationRef.current;
    setRefreshing(true);
    try {
      await Promise.allSettled(ids.map((hostId) => loadHost(hostId, true, generation)));
    } finally {
      setRefreshing(false);
    }
  }, [hostIdsKey, loadHost]);

  return { byHost, refreshing, refresh };
}

function MaskedEmail({ email }: { readonly email: string }) {
  const [revealed, setRevealed] = useState(false);
  if (!email.includes("@")) {
    return <Text className="text-xs text-foreground-tertiary">{email}</Text>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={revealed ? "Hide account email" : "Reveal account email"}
      onPress={() => setRevealed((current) => !current)}
      className="active:opacity-60"
    >
      <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
        {revealed ? email : maskEmail(email)}
      </Text>
    </Pressable>
  );
}

function UsageEmptyState({
  targetCount,
  rawOverview,
  onClearFilters,
}: {
  readonly targetCount: number;
  readonly rawOverview: UsageOverview;
  readonly onClearFilters: () => void;
}) {
  if (targetCount === 0) {
    return (
      <View className="pt-4">
        <MobileCallout kind="info">
          <Text className="text-xs text-foreground-muted">
            Select a connected environment to see remaining usage limits.
          </Text>
        </MobileCallout>
      </View>
    );
  }
  if (rawOverview.providers.length === 0 && rawOverview.loadingHosts.length > 0) {
    return (
      <View className="pt-4">
        <MobileCallout kind="info">
          <Text className="text-xs text-foreground-muted">
            Reading subscription limits from {rawOverview.loadingHosts.join(", ")}…
          </Text>
        </MobileCallout>
      </View>
    );
  }
  if (rawOverview.providers.length === 0) {
    return (
      <View className="pt-4">
        <MobileCallout kind="note">
          <Text className="text-xs text-foreground-muted">
            No connected harness reports subscription limits.
          </Text>
        </MobileCallout>
      </View>
    );
  }
  return (
    <View className="pt-4">
      <MobileCallout kind="info" actionLabel="Clear" onAction={onClearFilters}>
        <Text className="text-xs text-foreground-muted">
          No usage windows match the current filters.
        </Text>
      </MobileCallout>
    </View>
  );
}

export function UsageSettings({
  workspace = false,
}: { workspace?: boolean } = {}) {
  const envMenu = useSettingsEnvironmentMenu();
  const { scopedTargets } = useSolusSettingsFilter();
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const now = useNowMinuteMs();
  const [displayMode, setDisplayMode] = useState<UsageDisplayMode>("remaining");
  const [selectedProviders, setSelectedProviders] = useState<readonly AgentId[]>([]);
  const [stateFilter, setStateFilter] = useState<UsageStateFilter>("all");

  const hostIds = useMemo(() => scopedTargets.map((target) => target.environmentId), [scopedTargets]);
  const { byHost, refreshing, refresh } = useMultiHostUsage(hostIds, isFocused);

  const hostInputs: readonly HostUsageInput[] = useMemo(
    () =>
      scopedTargets.map((target) => {
        const entry = byHost[target.environmentId];
        const connected = solus.connections.readiness(target.environmentId).readiness === "ready";
        const availableProviders = entry?.availableProviders ?? readAvailableProviders(target.environmentId);
        if (!entry) {
          return {
            serverId: target.environmentId,
            label: target.environmentLabel,
            connected,
            state: "loading",
            snapshots: [],
            availableProviders,
          };
        }
        return {
          serverId: target.environmentId,
          label: target.environmentLabel,
          connected,
          state: entry.state,
          error: entry.error,
          snapshots: entry.snapshots,
          availableProviders,
        };
      }),
    [scopedTargets, byHost],
  );

  const rawOverview = useMemo(() => buildUsageOverview(hostInputs, now), [hostInputs, now]);
  const selectedProviderSet = useMemo(() => new Set<AgentId>(selectedProviders), [selectedProviders]);
  const overview = useMemo(
    () =>
      filterUsageOverview(rawOverview, {
        providers: selectedProviderSet,
        state: stateFilter,
      }),
    [rawOverview, selectedProviderSet, stateFilter],
  );
  const showHosts = scopedTargets.length > 1;
  const hasFilters = selectedProviders.length > 0 || stateFilter !== "all";

  const clearFilters = useCallback(() => {
    setSelectedProviders([]);
    setStateFilter("all");
  }, []);

  const toggleProvider = useCallback(
    (provider: AgentId) => {
      setSelectedProviders((current) => {
        const next = current.includes(provider)
          ? current.filter((item) => item !== provider)
          : [...current, provider];
        return next.length >= rawOverview.providers.length ? [] : next;
      });
    },
    [rawOverview.providers.length],
  );

  const usageFilterMenu: AppBarMenu = useMemo(
    () => ({
      title: "Filter usage",
      icon: hasFilters ? "slider.horizontal.3" : "ellipsis.circle",
      items: [
        {
          id: "harnesses",
          title:
            selectedProviders.length === 0
              ? "All harnesses"
              : `${selectedProviders.length} harness${selectedProviders.length === 1 ? "" : "es"}`,
          items: [
            {
              id: "harness:all",
              title: "All harnesses",
              selected: selectedProviders.length === 0,
              onPress: () => setSelectedProviders([]),
            },
            ...rawOverview.providers.map((group) => ({
              id: `harness:${group.provider}`,
              title: group.label,
              selected: selectedProviderSet.has(group.provider),
              onPress: () => toggleProvider(group.provider),
            })),
          ],
        },
        {
          id: "state",
          title:
            STATE_FILTER_OPTIONS.find((option) => option.value === stateFilter)?.label ??
            "All states",
          items: STATE_FILTER_OPTIONS.map((option) => ({
            id: `state:${option.value}`,
            title: option.label,
            selected: stateFilter === option.value,
            onPress: () => setStateFilter(option.value),
          })),
        },
        {
          id: "refresh",
          title: refreshing ? "Refreshing limits…" : "Refresh limits",
          icon: "arrow.clockwise",
          onPress: () => void refresh(),
        },
      ],
    }),
    [
      hasFilters,
      rawOverview.providers,
      refresh,
      refreshing,
      selectedProviderSet,
      selectedProviders.length,
      stateFilter,
      toggleProvider,
    ],
  );

  const sectionProviders = useMemo(
    () => overview.providers.filter(hasUsageSectionContent),
    [overview.providers],
  );

  const nonMeteredAccounts = useMemo(
    () =>
      overview.providers.flatMap((group) =>
        group.nonMeteredAccounts.filter((account) => account.status !== "unsupported"),
      ),
    [overview.providers],
  );

  const openAccount = (account: UsageAccountEntry) => {
    nav.navigate("SettingsUsageAccount", {
      accountKey: account.key,
      windowId: account.provider,
      windowKind: account.instanceId,
      environmentIds: account.hosts.map((host) => host.serverId),
      now,
    });
  };

  const scopeSummary = useMemo(() => {
    const hostPart =
      scopedTargets.length > 1
        ? `Hosts · ${scopedTargets.length}`
        : scopedTargets[0]?.environmentLabel ?? "No hosts";
    if (stateFilter === "all") return hostPart;
    const stateLabel =
      STATE_FILTER_OPTIONS.find((option) => option.value === stateFilter)?.label ?? stateFilter;
    return `${hostPart} · ${stateLabel}`;
  }, [scopedTargets, stateFilter]);

  const showEmpty =
    scopedTargets.length === 0 || (sectionProviders.length === 0 && nonMeteredAccounts.length === 0);

  return (
    <SettingsScreen title="Usage" workspaceRoot={workspace} menus={[envMenu, usageFilterMenu]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1 bg-background"
        contentContainerClassName="px-5 pt-3"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        <View className="flex-row items-center justify-between gap-3 border-b border-border-subtle pb-3.5">
          <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {scopeSummary}
            </Text>
            {hasFilters ? (
              <Pressable accessibilityRole="button" onPress={clearFilters} className="active:opacity-60">
                <Text className="text-xs font-t3-medium text-foreground">Clear</Text>
              </Pressable>
            ) : null}
          </View>
          <View className="w-32">
            <SegmentedControl
              options={DISPLAY_OPTIONS}
              selected={displayMode}
              onSelect={setDisplayMode}
              size="compact"
            />
          </View>
        </View>

        {showEmpty ? (
          <UsageEmptyState
            targetCount={scopedTargets.length}
            rawOverview={rawOverview}
            onClearFilters={clearFilters}
          />
        ) : (
          sectionProviders.map((group) => (
            <UsageHarnessBlock
              key={group.provider}
              group={group}
              displayMode={displayMode}
              showHosts={showHosts}
              onSelectAccount={openAccount}
            />
          ))
        )}

        <UsageNotices
          rawOverview={rawOverview}
          nonMeteredAccounts={nonMeteredAccounts}
          showHosts={showHosts}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          onSelectAccount={openAccount}
        />
      </ScrollView>
    </SettingsScreen>
  );
}

export function UsageAccountSettings({
  route,
}: StaticScreenProps<{
  accountKey: string;
  environmentIds: readonly string[] | null;
  windowKind: string;
  windowId: string;
  now: number;
}>) {
  const { hostsById } = useSolusWorkspace();
  const isFocused = useIsFocused();
  const now = useNowMinuteMs();
  const envIds = useMemo(
    () => (route.params.environmentIds?.length ? [...route.params.environmentIds] : Object.keys(hostsById)),
    [route.params.environmentIds, hostsById],
  );
  const { byHost, refreshing, refresh } = useMultiHostUsage(envIds, isFocused);

  const hostInputs: readonly HostUsageInput[] = useMemo(
    () =>
      envIds.map((id) => {
        const entry = byHost[id];
        return {
          serverId: id,
          label: hostsById[id]?.environmentLabel ?? id,
          connected: solus.connections.readiness(id).readiness === "ready",
          state: entry?.state ?? "loading",
          error: entry?.error,
          snapshots: entry?.snapshots ?? [],
          availableProviders: entry?.availableProviders ?? readAvailableProviders(id),
        };
      }),
    [envIds, byHost, hostsById],
  );

  const overview = useMemo(() => buildUsageOverview(hostInputs, now), [hostInputs, now]);
  const account = useMemo(
    () =>
      overview.providers
        .flatMap((group) => group.accounts)
        .find((candidate) => candidate.key === route.params.accountKey) ??
      overview.providers
        .flatMap((group) => group.accounts)
        .find((candidate) => candidate.provider === route.params.windowId) ??
      null,
    [overview, route.params.accountKey, route.params.windowId],
  );

  const checkedAt = account ? formatCheckedAt(account.fetchedAt) : null;

  return (
    <SettingsPage title={account?.displayName ?? "Account"}>
      {!account ? (
        <Note>
          {overview.loadingHosts.length > 0
            ? "Loading account limits…"
            : "This account is no longer reporting limits on the selected environments."}
        </Note>
      ) : (
        <>
          <SettingsSection title="Account">
            <View className="gap-1.5 px-4 py-3">
              <View className="flex-row items-center gap-2">
                <ProviderIcon provider={t3DriverFor(account.provider)} size={20} />
                <Text className="text-base font-t3-medium text-foreground">
                  {account.displayName}
                </Text>
              </View>
              {account.email ? <MaskedEmail email={account.email} /> : null}
              {account.planType ? (
                <Text className="text-sm text-foreground-muted">{account.planType}</Text>
              ) : null}
              {checkedAt ? (
                <Text className="text-xs text-foreground-tertiary">
                  {account.stale ? `Last known · ${checkedAt}` : `Updated ${checkedAt}`}
                </Text>
              ) : null}
            </View>
          </SettingsSection>

          {account.windows.length > 0 ? (
            <SettingsSection title="Limits">
              {account.windows.map((window, index) => {
                const exactReset = formatExactResetTime(window.resetsAt);
                return (
                  <View
                    key={window.id}
                    className={`gap-1 px-4 py-3 ${index > 0 ? "border-t border-border-subtle" : ""}`}
                  >
                    <View className="flex-row items-baseline justify-between gap-2">
                      <Text className="text-sm font-t3-medium text-foreground">
                        {window.groupLabel ? `${window.groupLabel} · ${window.label}` : window.label}
                      </Text>
                      <Text className="text-base font-t3-bold tabular-nums text-foreground">
                        {Math.round(window.remainingPercent)}% left
                      </Text>
                    </View>
                    {window.suppressedByWeekly ? (
                      <Text className="text-xs text-red-500">Blocked by weekly limit</Text>
                    ) : window.pace ? (
                      <Text className="text-xs text-foreground-muted">
                        {paceLabel(window.pace)}
                        {window.paceRemainingPercent !== null
                          ? ` · Even pace: ${window.paceRemainingPercent}% left by now`
                          : ""}
                      </Text>
                    ) : null}
                    {exactReset ? (
                      <Text selectable className="text-xs text-foreground-tertiary">
                        Resets {exactReset}
                      </Text>
                    ) : window.resetCountdown ? (
                      <Text className="text-xs text-foreground-tertiary">{window.resetCountdown}</Text>
                    ) : null}
                  </View>
                );
              })}
            </SettingsSection>
          ) : (
            <SettingsSection title="Status">
              <Note>
                {account.status === "api"
                  ? "Metered API billing. Subscription quota windows do not apply."
                  : account.status === "signed_out"
                    ? "Signed out on this host."
                    : account.status === "unsupported"
                      ? usageUnsupportedMessage(account.provider)
                      : "Could not read subscription limits."}
              </Note>
            </SettingsSection>
          )}

          <SettingsSection title="Signed in on">
            {account.hosts.map((host) => (
              <View key={host.serverId} className="px-4 py-2.5">
                <Text className="text-sm text-foreground">{host.label}</Text>
              </View>
            ))}
          </SettingsSection>

          <SettingsSection>
            <SettingsRow
              icon="arrow.clockwise"
              label={refreshing ? "Refreshing…" : "Refresh limits"}
              disabled={refreshing}
              onPress={() => void refresh()}
            />
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  );
}

const readModel = (api: HostApi) => api.voiceModelStatus();
export function VoiceModelSettings({
  route,
}: StaticScreenProps<{ environmentId: EnvironmentId }>) {
  const state = useHostSettingsRead(
    route.params.environmentId,
    readModel,
    "voice.modelStatusChanged",
  );
  const { run, busy } = useSettingsAction(state.refresh);
  return (
    <SettingsPage title="Transcription model">
      <SettingsSection title="Host model">
        <Note>
          {state.error ??
            state.data?.error ??
            state.data?.state ??
            "Reading model status…"}
        </Note>
        {state.data?.state === "error" && (
          <SettingsRow
            icon="arrow.clockwise"
            label="Retry model installation"
            disabled={busy}
            onPress={() => void run(() => state.api!.voiceModelRetry())}
          />
        )}
        <SettingsRow
          icon="arrow.clockwise"
          label="Refresh"
          onPress={state.refresh}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
