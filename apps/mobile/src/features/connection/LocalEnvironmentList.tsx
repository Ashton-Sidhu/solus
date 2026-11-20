// Adapted from T3 Code apps/mobile/src/features/connection/LocalEnvironmentList.tsx (MIT, see UPSTREAM.md).
import type { ComponentProps } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import type { AnswerState } from "@solus/client-core/host-catalog";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { KnownHost } from "@solus/client-core/known-host";
import { ConnectionEnvironmentRow } from "./ConnectionEnvironmentRow";

type EnvironmentRowProps = ComponentProps<typeof ConnectionEnvironmentRow>;

/**
 * Shared list and empty state for host management entry points. The list is read
 * from the person's host list on each start (plans/033 §3 Q2): it shows loading
 * until the first read, and a failed read with Try again beside the hosts this
 * device can still dial.
 */
export function LocalEnvironmentList({
  hosts,
  listState,
  onRetry,
  expandedId,
  onToggle,
  onAdd,
  ...rowActions
}: Pick<EnvironmentRowProps, "onReconnect" | "onRemove" | "opensDetails"> & {
  readonly hosts: ReadonlyArray<KnownHost>;
  /** Where the read of the person's host list is. */
  readonly listState: AnswerState;
  /** Reads the host list again. */
  readonly onRetry: () => void;
  readonly expandedId: string | null;
  readonly onToggle: (hostId: string) => void;
  /** Opens pairing; the empty state offers it as its action. */
  readonly onAdd?: () => void;
}) {
  const failure =
    listState === "failed" ? (
      <View collapsable={false} className="gap-3 rounded-[24px] bg-grouped-card p-5">
        <Text className="text-base font-t3-bold text-foreground">Could not load your hosts</Text>
        <Text className="text-sm leading-normal text-foreground-muted">
          {hosts.length > 0
            ? "Only the hosts paired on this device show. Check your connection and try again."
            : "Check your connection and try again."}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          className="self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
        >
          <Text className="text-xs font-t3-bold text-foreground">Try again</Text>
        </Pressable>
      </View>
    ) : null;

  if (hosts.length === 0 && listState === "loading") {
    return (
      <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-grouped-card p-6">
        <ActivityIndicator colorClassName={"accent-icon"} />
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          Loading your hosts.
        </Text>
      </View>
    );
  }

  if (hosts.length === 0 && failure) return failure;

  if (hosts.length === 0) {
    return (
      <View
        collapsable={false}
        className="items-center gap-3 rounded-[24px] bg-grouped-card px-6 py-8"
      >
        <View className="h-12 w-12 items-center justify-center rounded-[16px] bg-subtle">
          <SymbolView
            name="point.3.connected.trianglepath.dotted"
            size={20}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </View>
        <View className="items-center gap-1">
          <Text accessibilityRole="header" className="text-base font-t3-bold text-foreground">
            No hosts yet
          </Text>
          <Text className="text-center text-sm leading-normal text-foreground-muted">
            A host is a computer running Solus. Pair one to run its agents from this device.
          </Text>
        </View>
        {onAdd ? (
          <Pressable
            accessibilityRole="button"
            className="mt-1 min-h-11 flex-row items-center gap-1.5 rounded-full bg-primary px-5 py-2.5 active:opacity-70"
            onPress={onAdd}
          >
            <SymbolView
              name="plus"
              size={13}
              tintColorClassName="accent-primary-foreground"
              type="monochrome"
            />
            <Text className="text-sm font-t3-bold text-primary-foreground">Add host</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View collapsable={false} className="gap-3">
      <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
        {hosts.map((host) => (
          <View key={host.id} collapsable={false}>
            <ConnectionEnvironmentRow
              host={host}
              expanded={expandedId === host.id}
              onToggle={() => onToggle(host.id)}
              {...rowActions}
            />
          </View>
        ))}
      </View>
      {failure}
    </View>
  );
}
