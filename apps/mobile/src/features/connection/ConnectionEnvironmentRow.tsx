// Adapted from T3 Code apps/mobile/src/features/connection/ConnectionEnvironmentRow.tsx (MIT, see UPSTREAM.md).
import { SymbolView } from "../../components/AppSymbol";
import { Platform, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { MaterialButton } from "../../components/MaterialButton";
import { MaterialIconButton } from "../../components/MaterialIconButton";
import { cn } from "../../lib/cn";
import type { NativeHost } from "../hosts/host-registry";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import {
  hostConnectionStatus,
  hostDisplayAddress,
  hostMachineKind,
} from "./lib/host-connection-status";

/**
 * One saved host. Solus hosts have no on/off switch and no editable label or
 * address, so T3's switch and Label/URL editor are left out; the expanded row
 * keeps T3's actions: reconnect and forget.
 */
export function ConnectionEnvironmentRow(props: {
  readonly host: NativeHost;
  readonly expanded: boolean;
  readonly opensDetails?: boolean;
  readonly onToggle: () => void;
  readonly onReconnect: (hostId: string) => void;
  readonly onRemove: (host: NativeHost) => void;
}) {
  const app = useApp();
  const state = useListened(app.connections.changes, () => app.connections.state(props.host.id));
  const status = hostConnectionStatus(props.host, state);
  const address = props.host.uplink ? null : hostDisplayAddress(props.host);

  return (
    <Animated.View layout={LinearTransition.duration(250)} className="bg-grouped-card">
      <Pressable
        className="flex-row items-center gap-3 px-4 py-3.5 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={`${props.host.label}, ${status.text}`}
        accessibilityHint={props.opensDetails ? "Opens the host's settings" : undefined}
        // The row is one accessible element, so its inline Try again is offered as an action.
        accessibilityActions={
          props.opensDetails && status.retryable ? [{ name: "retry", label: "Try again" }] : undefined
        }
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "retry") props.onReconnect(props.host.id);
        }}
        onPress={props.onToggle}
      >
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center gap-1.5">
            <ConnectionStatusDot state={status.dot} pulse={status.retrying} size={8} />
            <EnvironmentMachineSymbol
              kind={hostMachineKind(props.host)}
              size={14}
              tintColorClassName="accent-foreground-muted"
            />
            <Text
              className="min-w-0 flex-shrink text-base font-t3-bold leading-snug text-foreground"
              numberOfLines={1}
            >
              {props.host.label}
            </Text>
          </View>
          {address ? (
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {address}
            </Text>
          ) : null}
          <Text
            className={cn(
              "text-xs",
              status.failed ? "text-danger-foreground" : "text-foreground-muted",
            )}
            numberOfLines={props.expanded ? undefined : 1}
            selectable={props.expanded}
          >
            {status.text}
          </Text>
        </View>

        {props.opensDetails && status.retryable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Try ${props.host.label} again`}
            hitSlop={6}
            className="min-h-9 items-center justify-center rounded-full bg-subtle px-3 active:opacity-70"
            onPress={() => props.onReconnect(props.host.id)}
          >
            <Text className="text-sm font-t3-medium text-foreground">Try again</Text>
          </Pressable>
        ) : null}

        <SymbolView
          name={props.opensDetails ? "chevron.right" : "chevron.down"}
          size={12}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
          style={{
            transform: [{ rotate: props.expanded ? "180deg" : "0deg" }],
          }}
        />
      </Pressable>

      {props.expanded ? (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          className="gap-3 px-4 pb-4"
        >
          {props.host.uplink ? (
            <Text className="text-sm text-foreground-muted">
              Managed by Solus Cloud. Its address updates automatically.
            </Text>
          ) : null}

          {Platform.OS === "android" ? (
            <View className="flex-row items-center justify-end gap-2">
              <View className="flex-1">
                <MaterialButton
                  label="Reconnect"
                  tone="primary"
                  fullWidth
                  onPress={() => props.onReconnect(props.host.id)}
                />
              </View>
              <MaterialIconButton
                accessibilityLabel="Forget host"
                icon="trash"
                variant="danger"
                onPress={() => props.onRemove(props.host)}
              />
            </View>
          ) : (
            <View className="flex-row justify-end gap-2">
              <Pressable
                accessibilityRole="button"
                className="min-h-[42px] flex-1 flex-row items-center justify-center gap-1.5 rounded-[14px] bg-primary px-3.5 py-2.5 active:opacity-70"
                onPress={() => props.onReconnect(props.host.id)}
              >
                <SymbolView
                  name="arrow.clockwise"
                  size={13}
                  tintColorClassName="accent-primary-foreground"
                  type="monochrome"
                />
                <Text className="text-sm font-t3-bold text-primary-foreground">Reconnect</Text>
              </Pressable>

              <Pressable
                accessibilityLabel="Forget host"
                accessibilityRole="button"
                className="h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-danger-border bg-danger active:opacity-70"
                onPress={() => props.onRemove(props.host)}
              >
                <SymbolView
                  name="trash"
                  size={14}
                  tintColorClassName="accent-danger-foreground"
                  type="monochrome"
                />
              </Pressable>
            </View>
          )}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}
