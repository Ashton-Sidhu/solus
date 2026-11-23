import { SheetCloseButton } from "../../components/ui/SheetHeader";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { deviceToolVersionLabels } from "@t3tools/client-runtime/state/device";
import { solus } from "../../solus/runtime";
import { useListened } from "@solus-mobile/app/app-context";
import { useDeviceControlRenewal } from "../../solus/devices/useDeviceControlRenewal";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { msg, useGT } from "gt-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Haptics from "expo-haptics";
import { Accelerometer } from "expo-sensors";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { GlassSurface } from "../../components/ui/GlassSurface";
import {
  findAppBarMenuItem,
  menuActionsFromAppBarItems,
} from "../../components/ui/menuActionItems";
import { AppBar } from "../../components/ui/AppBar";
import { m } from "../../i18n/messages";
import { useBarOverlap } from "../../components/ui/useBarInset";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { useAppForeground } from "../../lib/appState";
import { useHardwareBack } from "../../lib/backHandler";
import { deriveBottomControlInsets } from "../../lib/reserved-regions";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { DeviceStreamWebView, type DeviceStreamRef } from "../../solus/devices/DeviceStreamWebView";
import {
  selectedThreadDevicePreview,
  threadDevicePreviews,
} from "../../solus/devices/threadDevicePreviews";
import { createShakeDetector } from "./shakeDetector";

const OVERLAY_ENTERING = FadeIn.duration(160).reduceMotion(ReduceMotion.System);
const OVERLAY_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

type DevicePreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly deviceKey?: string;
}>;

export function DevicePreviewRouteScreen({ route }: DevicePreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = () => navigation.goBack();
  const { environmentId, threadId } = route.params;
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops a deep-linked route with a blank environment or thread off the navigator
  useEffect(() => {
    if (isBlankLink) onClose();
  }, [isBlankLink, onClose]);
  if (isBlankLink) return null;
  return (
    <DevicePreviewScreen
      environmentId={EnvironmentId.make(environmentId)}
      threadId={ThreadId.make(threadId)}
      initialDeviceKey={route.params.deviceKey}
      onClose={onClose}
    />
  );
}

export function DevicePreviewScreen({
  environmentId,
  threadId,
  onClose,
  onMaximize,
  initialDeviceKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
  readonly onMaximize?: (deviceKey: string | null) => void;
  readonly initialDeviceKey?: string;
}) {
  const embedded = onMaximize !== undefined;
  const insets = useSafeAreaInsets();
  // In a pane the stream sits below the pane's bar, which content otherwise slides under.
  const barOverlap = useBarOverlap();
  // NativeColumnContent already insets the sides, so only a book fold moves the hidden-controls pill.
  const handleBounds = deriveBottomControlInsets(useNativeColumnLayoutMetrics());
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [selectedKey, setSelectedKey] = useState<string | null>(initialDeviceKey ?? null);
  const [streaming, setStreaming] = useState(false);
  const gt = useGT();
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [shuttingDown, setShuttingDown] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const streamRef = useRef<DeviceStreamRef>(null);
  const state = useListened(solus.devices.changes, () => solus.devices.stateOf(environmentId));
  const error = useListened(solus.devices.changes, () => solus.devices.errorOf(environmentId));
  const previews = useMemo(() => threadDevicePreviews(state, threadId), [state, threadId]);
  const preview = selectedThreadDevicePreview(previews, selectedKey ?? undefined);
  const target = preview?.preview;
  const held = useListened(
    solus.devices.changes,
    () => !!target && solus.devices.holdsControl(environmentId, target),
  );
  const inputConnected = streaming && held;
  useDeviceControlRenewal(
    environmentId,
    threadId,
    focused && foreground && held ? target : undefined,
  );
  useEffect(() => {
    void solus.devices.load(environmentId, true);
  }, [environmentId]);
  const takeControl = async () => {
    if (!target) return false;
    try {
      await solus.devices.takeControl(environmentId, target, threadId);
      return solus.devices.holdsControl(environmentId, target);
    } catch (cause) {
      Dialog.alert("Could not take control", String(cause));
      return false;
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the Accelerometer while focused to toggle controls on a shake
  useEffect(() => {
    if (!focused || !foreground || embedded) return;
    const shaken = createShakeDetector();
    Accelerometer.setUpdateInterval(50);
    const subscription = Accelerometer.addListener((sample) => {
      if (!shaken({ ...sample, timestamp: sample.timestamp * 1000 })) return;
      void Haptics.selectionAsync();
      setControlsVisible((visible) => !visible);
    });
    return () => subscription.remove();
  }, [focused, foreground, embedded]);
  useHardwareBack(!controlsVisible, () => {
    setControlsVisible(true);
    return true;
  });

  const shutDownDevice = async () => {
    if (!preview || shuttingDown) return;
    setShuttingDown(true);
    try {
      await solus.devices.shutdown(environmentId, preview.preview);
    } catch (cause) {
      Dialog.alert(m(msg("Could not shut down device")), String(cause));
    } finally {
      setShuttingDown(false);
    }
  };

  const controls: AppBarMenuItem[] = [
    ...(state?.hostStatuses
      .filter((entry) => entry.status === "failed")
      .map((entry) => ({
        id: "retry-" + entry.deviceHostId,
        title: gt("Retry {host}", {
          host:
            state.hosts.find((host) => host.deviceHostId === entry.deviceHostId)?.label ??
            entry.deviceHostId,
        }),
        icon: "arrow.clockwise",
        onPress: () =>
          void solus.devices
            .retryHost(environmentId, entry.deviceHostId)
            .catch((cause) => Dialog.alert("Devices", String(cause))),
      })) ?? []),
    {
      id: "check-device-tools",
      title: gt("Check device tool versions"),
      icon: "arrow.clockwise",
      onPress: () =>
        void solus.devices
          .change(environmentId, (api) => api.deviceToolInspect())
          .catch((cause) => Dialog.alert("Device tools", String(cause))),
    },
    {
      id: "device-tools",
      title: gt("Device tool versions"),
      icon: "info.circle",
      onPress: () =>
        Dialog.alert(
          m(msg("Device tool versions")),
          state?.hosts
            .map((host) =>
              [host.label, ...deviceToolVersionLabels(host.tools, m), host.toolInspectionError]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n\n") || "No hosts available.",
        ),
    },
    ...(state?.devices ?? [])
      .filter(
        (device) =>
          !previews.some(
            (item) =>
              item.preview.deviceId === device.deviceId &&
              item.preview.deviceHostId === device.deviceHostId,
          ),
      )
      .map((device) => ({
        id: JSON.stringify([device.deviceHostId, device.deviceId]),
        title: device.name,
        subtitle: device.unavailableReason ?? device.version,
        disabled: shuttingDown || !!device.unavailableReason,
        onPress: async () => {
          setShuttingDown(true);
          try {
            await solus.devices.open(environmentId, threadId, device);
            setSelectedKey(JSON.stringify([device.deviceHostId, device.deviceId]));
          } catch (cause) {
            Dialog.alert("Could not open device", String(cause));
          } finally {
            setShuttingDown(false);
          }
        },
      })),
    {
      id: "refresh",
      title: gt("Refresh"),
      onPress: () => void solus.devices.load(environmentId, true),
    },
    ...(target
      ? [
          {
            id: "control",
            title: held ? "Release control" : "Take control",
            onPress: () =>
              held
                ? void solus.devices
                    .release(environmentId, target)
                    .catch((cause) => Dialog.alert("Devices", String(cause)))
                : void takeControl(),
          },
          {
            id: "close",
            title: "Close preview",
            onPress: () =>
              void solus.devices
                .close(environmentId, threadId, target)
                .catch((cause) => Dialog.alert("Devices", String(cause))),
          },
        ]
      : []),
    {
      id: "reload",
      title: gt("Reload stream"),
      icon: "arrow.clockwise" as const,
      disabled: !preview || shuttingDown,
      onPress: () => {
        setStreaming(false);
        setStreamAttempt((attempt) => attempt + 1);
      },
    },
    ...(preview?.preview.platform === "android"
      ? [
          {
            id: "back",
            title: gt("Back", { $context: "Android back button" }),
            icon: "arrow.left",
            disabled: !inputConnected,
            onPress: () => streamRef.current?.press("back"),
          },
        ]
      : []),
    {
      id: "app-switcher",
      title: gt("App switcher"),
      icon: "square.on.square",
      disabled: !inputConnected,
      onPress: () =>
        streamRef.current?.press(
          preview?.preview.platform === "android" ? "recents" : "appSwitcher",
        ),
    },
    ...(preview?.preview.platform === "ios"
      ? [
          {
            id: "rotate",
            title: gt("Rotate device"),
            icon: "arrow.clockwise" as const,
            disabled: !inputConnected,
            onPress: () => streamRef.current?.press("rotate"),
          },
        ]
      : []),
    {
      id: "shutdown",
      title: shuttingDown ? gt("Shutting down…") : gt("Shut down device"),
      icon: "power",
      disabled: !held || shuttingDown,
      onPress: () => void shutDownDevice(),
    },
  ];
  const pressHome = () => streamRef.current?.press("home");
  const menuItems: AppBarMenuItem[] = [
    ...(previews.length > 1
      ? [
          {
            id: "devices",
            title: gt("Devices", { $context: "device list heading" }),
            inline: true,
            items: previews.map((device) => ({
              id: device.key,
              title: device.name,
              subtitle: device.description,
              selected: device.key === preview?.key,
              onPress: () => setSelectedKey(device.key),
            })),
          },
        ]
      : []),
    ...controls,
  ];
  return (
    <View className="flex-1" style={{ backgroundColor: themeVariables["--color-sheet-solid"] }}>
      {embedded ? (
        <>
          <AppBar
            title={preview?.name ?? gt("Devices", { $context: "screen title" })}
            actions={[
              {
                accessibilityLabel: gt("Maximize device"),
                icon: "arrow.up.left.and.arrow.down.right",
                onPress: () => onMaximize(preview?.key ?? null),
              },
            ]}
          />
          <View style={{ height: barOverlap }} />
        </>
      ) : null}
      {preview && focused && foreground ? (
        <DeviceStreamWebView
          key={`${preview.key}:${streamAttempt}`}
          hostId={environmentId}
          target={preview.preview}
          platform={preview.preview.platform}
          kind={preview.kind}
          enabled={held}
          onTakeControl={takeControl}
          ref={streamRef}
          colors={{
            background: themeVariables["--color-sheet-solid"],
            muted: themeVariables["--color-foreground-muted"],
          }}
          onStreamingChange={setStreaming}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-4 px-6">
          {error ? (
            <>
              <AppText selectable className="text-center text-sm text-foreground-muted">
                {error}
              </AppText>
              <View className="items-center">
                <Button
                  label={gt("Retry")}
                  tone="secondary"
                  onPress={() => void solus.devices.load(environmentId, true)}
                />
              </View>
            </>
          ) : state ? (
            <AppText>
              {state.devices.length
                ? "Select a device in Device options."
                : "No devices found on this host."}
            </AppText>
          ) : focused && foreground ? (
            <AppActivityIndicator color={themeVariables["--color-icon"]} />
          ) : null}
        </View>
      )}
      {embedded ? (
        <View
          className="flex-row items-center justify-center gap-2 px-3 py-2"
          style={{ paddingBottom: Math.max(insets.bottom, 8) }}
        >
          <ControlPill
            accessibilityLabel={gt("Home", { $context: "device home button" })}
            icon="house"
            disabled={!inputConnected}
            onPress={pressHome}
          />
          <DeviceOptionsMenu items={menuItems} />
        </View>
      ) : controlsVisible ? (
        <Animated.View
          entering={OVERLAY_ENTERING}
          exiting={OVERLAY_EXITING}
          pointerEvents="box-none"
          className="absolute inset-0"
        >
          {inputConnected ? (
            <Pressable
              accessibilityLabel={gt("Hide device controls")}
              className="absolute inset-0 bg-black/30"
              onPress={() => setControlsVisible(false)}
            />
          ) : null}
          <View className="px-3" style={{ paddingTop: Math.max(insets.top, 12) }}>
            <GlassSurface className="flex-row items-center gap-1 p-1">
              <SheetCloseButton accessibilityLabel={gt("Close device preview")} onClose={onClose} />
              <AppText numberOfLines={1} className="flex-1 text-center font-t3-medium text-base">
                {preview?.name ?? gt("Devices", { $context: "screen title" })}
              </AppText>
              <ControlPill
                accessibilityLabel={gt("Home", { $context: "device home button" })}
                icon="house"
                disabled={!inputConnected}
                onPress={pressHome}
              />
              <DeviceOptionsMenu items={menuItems} />
            </GlassSurface>
          </View>
        </Animated.View>
      ) : (
        <View
          pointerEvents="box-none"
          className="absolute self-center"
          style={{
            top: Math.max(insets.top, 12),
            transform: [{ translateX: (handleBounds.left - handleBounds.right) / 2 }],
          }}
        >
          <GlassSurface className="flex-row items-center gap-1 p-1">
            <SheetCloseButton accessibilityLabel={gt("Close device preview")} onClose={onClose} />
            <ControlPill
              accessibilityLabel={gt("Show device controls")}
              icon="chevron.down"
              onPress={() => setControlsVisible(true)}
            />
          </GlassSurface>
        </View>
      )}
    </View>
  );
}

function DeviceOptionsMenu({ items }: { readonly items: ReadonlyArray<AppBarMenuItem> }) {
  const gt = useGT();
  return (
    <Menu
      actions={menuActionsFromAppBarItems(items)}
      isAnchoredToRight
      title={gt("Device options")}
      onPressAction={({ nativeEvent }) => {
        const action = findAppBarMenuItem(items, nativeEvent.event);
        if (action && !action.disabled) action.onPress();
      }}
    >
      <ControlPill icon="ellipsis" accessibilityLabel={gt("Device options")} />
    </Menu>
  );
}
