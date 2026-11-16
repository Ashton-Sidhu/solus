// Adapted from T3 Code apps/mobile/src/features/devices/DevicePreviewRouteScreen.tsx (MIT, see UPSTREAM.md).
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ActivityIndicator, Alert, BackHandler, Linking, Pressable, StatusBar, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { DeviceControlLease, DeviceTarget } from "@solus/contracts/device-types";

import { useApp, useListened } from "../../app/app-context";
import { AppText } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { GlassSurface } from "../../components/GlassSurface";
import { findMenuItem, menuActionsFromItems } from "../../components/menuActionItems";
import type { ScreenHeaderMenuItem } from "../../components/ScreenHeader.types";
import { useAppForeground } from "../../lib/appState";
import type { ScreenProps } from "../../navigation/routes";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { DeviceStreamWebView, type DeviceStreamRef } from "./DeviceStreamWebView";
import { deviceViewerMenuItems } from "./device-viewer-menu";
import { selectedThreadDevicePreview, threadDevicePreviews, type ThreadDevicePreview } from "./threadDevicePreviews";

const OVERLAY_ENTERING = FadeIn.duration(160).reduceMotion(ReduceMotion.System);
const OVERLAY_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);
/** A user's control lease lapses unless the visible viewer renews it. */
const CONTROL_RENEW_MS = 10_000;

export function DevicePreviewRouteScreen({ route, navigation }: ScreenProps<"ThreadDevicePreview">) {
  const { hostId, sessionId } = route.params;
  const app = useApp();
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const state = useListened(app.devices.changes, () => app.devices.stateOf(hostId));
  const error = useListened(app.devices.changes, () => app.devices.errorOf(hostId));
  const [selectedKey, setSelectedKey] = useState(route.params.deviceKey);
  const [streaming, setStreaming] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [typing, setTyping] = useState(false);
  const streamRef = useRef<DeviceStreamRef>(null);
  const previews = threadDevicePreviews(state, sessionId);
  const selected = selectedThreadDevicePreview(previews, selectedKey);
  const target = selected?.preview;
  const control = target
    ? state?.controls.find((entry) => entry.deviceHostId === target.deviceHostId && entry.deviceId === target.deviceId)
    : undefined;
  const ownsControl = useListened(app.devices.changes, () => (target ? app.devices.holdsControl(hostId, target) : false));
  const inputConnected = streaming && ownsControl;
  const live = focused && foreground;
  const onClose = () => navigation.goBack();

  useEffect(() => {
    void app.devices.load(hostId);
  }, [app, hostId]);
  // The thread has no device left: the route has nothing to show.
  useEffect(() => {
    if (focused && state !== undefined && previews.length === 0) navigation.goBack();
  }, [focused, state, previews.length, navigation]);
  useControlRenewal(hostId, sessionId, live && ownsControl ? target : undefined);
  useEffect(() => {
    if (controlsVisible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setControlsVisible(true);
      return true;
    });
    return () => subscription.remove();
  }, [controlsVisible]);
  if (!inputConnected && !controlsVisible) setControlsVisible(true);

  const run = (label: string, work: () => Promise<void>) => {
    setBusy(true);
    return work()
      .catch((cause: unknown) => Alert.alert(label, cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  const toggleControl = () => {
    if (!target) return;
    void run(ownsControl ? "Could not release control" : "Could not take control", () =>
      ownsControl ? app.devices.release(hostId, target) : app.devices.takeControl(hostId, target, sessionId),
    );
  };
  const menuItems: ScreenHeaderMenuItem[] =
    selected && target
      ? deviceViewerMenuItems(
          { previews, selected, state, ownsControl, agentPaused: control?.agentPaused === true, inputConnected, busy },
          {
            select: setSelectedKey,
            retryHost: (deviceHostId) => void run("Could not retry the device host", () => app.devices.retryHost(hostId, deviceHostId)),
            toggleControl,
            resumeAgent: () => void run("Could not resume the agent", () => app.devices.resume(hostId, target)),
            reloadStream: () => {
              setStreaming(false);
              setStreamAttempt((attempt) => attempt + 1);
            },
            press: (button) => streamRef.current?.press(button),
            startTyping: () => setTyping(true),
            screenshot: () =>
              void run("Could not take a screenshot", async () => {
                await Linking.openURL(await app.devices.screenshotUrl(hostId, target));
              }),
            close: () => void run("Could not close the preview", () => app.devices.close(hostId, sessionId, target)),
            shutdown: () => void run("Could not shut down device", () => app.devices.shutdown(hostId, target)),
          },
        )
      : [];
  const background = themeVariables["--color-sheet-solid"];
  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      <StatusBar hidden animated />
      {selected !== null && live ? (
        <OpenDevicePreview
          key={`${selected.key}:${streamAttempt}`}
          hostId={hostId}
          preview={selected}
          enabled={ownsControl}
          onTakeControl={async () => {
            try {
              await app.devices.takeControl(hostId, selected.preview, sessionId);
              const granted = app.devices.holdsControl(hostId, selected.preview);
              if (granted) setControlsVisible(false);
              return granted;
            } catch (cause) {
              Alert.alert("Could not take control", cause instanceof Error ? cause.message : String(cause));
              return false;
            }
          }}
          streamRef={streamRef}
          onStreamingChange={setStreaming}
        />
      ) : (
        <DeviceViewerWaiting error={error} live={live} onRetry={() => void app.devices.load(hostId, true)} />
      )}
      <DeviceControls
        visible={controlsVisible}
        top={Math.max(insets.top, 12)}
        title={selected?.name}
        inputConnected={inputConnected}
        menuItems={menuItems}
        // Who holds the device, while this viewer does not.
        controlLabel={target && !ownsControl ? controlHolderLabel(control?.lease) : null}
        busy={busy}
        typing={typing && inputConnected}
        onShow={() => setControlsVisible(true)}
        onHide={() => setControlsVisible(false)}
        onClose={onClose}
        onHome={() => streamRef.current?.press("home")}
        onTakeControl={toggleControl}
        onType={(text) => streamRef.current?.type(text)}
        onDoneTyping={() => setTyping(false)}
      />
    </View>
  );
}

/** T3's glass bar over the stream. While input reaches the device, a tap outside it hides it. */
function DeviceControls(props: {
  /** Hidden leaves only a close and a show pill, so the whole screen is the device. */
  readonly visible: boolean;
  readonly top: number;
  readonly title: string | undefined;
  readonly inputConnected: boolean;
  readonly menuItems: ReadonlyArray<ScreenHeaderMenuItem>;
  /** Who holds the device, while this viewer does not. */
  readonly controlLabel: string | null;
  readonly busy: boolean;
  readonly typing: boolean;
  readonly onShow: () => void;
  readonly onHide: () => void;
  readonly onClose: () => void;
  readonly onHome: () => void;
  readonly onTakeControl: () => void;
  readonly onType: (text: string) => void;
  readonly onDoneTyping: () => void;
}) {
  if (!props.visible) {
    return (
      <View pointerEvents="box-none" className="absolute self-center" style={{ top: props.top }}>
        <GlassSurface className="flex-row items-center gap-1 rounded-full p-1">
          <ControlPill icon="xmark" accessibilityLabel="Close device preview" onPress={props.onClose} />
          <ControlPill accessibilityLabel="Show device controls" icon="chevron.down" onPress={props.onShow} />
        </GlassSurface>
      </View>
    );
  }
  return (
    <Animated.View entering={OVERLAY_ENTERING} exiting={OVERLAY_EXITING} pointerEvents="box-none" className="absolute inset-0">
      {props.inputConnected && !props.typing ? (
        <Pressable accessibilityLabel="Hide device controls" className="absolute inset-0 bg-black/30" onPress={props.onHide} />
      ) : null}
      <View className="gap-2 px-3" style={{ paddingTop: props.top }}>
        <GlassSurface className="flex-row items-center gap-1 rounded-full p-1">
          <ControlPill icon="xmark" accessibilityLabel="Close device preview" onPress={props.onClose} />
          <AppText numberOfLines={1} className="flex-1 text-center font-t3-medium text-base text-foreground">
            {props.title ?? "Devices"}
          </AppText>
          <ControlPill accessibilityLabel="Home" icon="house" disabled={!props.inputConnected} onPress={props.onHome} />
          <DeviceOptionsMenu items={props.menuItems} />
        </GlassSurface>
        {props.controlLabel !== null ? (
          <GlassSurface className="flex-row items-center gap-2 rounded-full p-1 pl-4">
            <AppText numberOfLines={1} className="flex-1 text-sm text-foreground-muted">
              {props.controlLabel}
            </AppText>
            <ControlPill variant="pill" label="Take control" disabled={props.busy} onPress={props.onTakeControl} />
          </GlassSurface>
        ) : null}
        {props.typing ? <DeviceTypeBar onSend={props.onType} onDone={props.onDoneTyping} /> : null}
      </View>
    </Animated.View>
  );
}

/**
 * Only the visible controller renews its grant, and it gives the device back when it leaves.
 * A takeover elsewhere ends it.
 */
function useControlRenewal(hostId: string, sessionId: string, held: DeviceTarget | undefined) {
  const app = useApp();
  const deviceHostId = held?.deviceHostId;
  const deviceId = held?.deviceId;
  useEffect(() => {
    if (deviceHostId === undefined || deviceId === undefined) return;
    const target = { deviceHostId, deviceId };
    const timer = setInterval(() => {
      if (app.devices.holdsControl(hostId, target)) void app.devices.takeControl(hostId, target, sessionId).catch(() => {});
    }, CONTROL_RENEW_MS);
    return () => {
      clearInterval(timer);
      if (app.devices.holdsControl(hostId, target)) void app.devices.release(hostId, target).catch(() => {});
    };
  }, [app, hostId, sessionId, deviceHostId, deviceId]);
}

function DeviceViewerWaiting(props: { readonly error: string | undefined; readonly live: boolean; readonly onRetry: () => void }) {
  return (
    <View className="flex-1 items-center justify-center gap-4 px-6">
      {props.error ? (
        <>
          <AppText selectable className="text-center text-sm text-foreground-muted">
            {props.error}
          </AppText>
          <ControlPill variant="pill" label="Retry" onPress={props.onRetry} />
        </>
      ) : props.live ? (
        <ActivityIndicator colorClassName="accent-icon" />
      ) : null}
    </View>
  );
}

/** Who holds the device now. A lapsed lease is nobody's. */
function controlHolderLabel(lease: DeviceControlLease | null | undefined): string {
  return lease && lease.expiresAt > Date.now() ? `${lease.holder.label} controls this device.` : "Take control to interact.";
}

/** Text for the device's focused field, for a phone with no hardware keyboard. */
function DeviceTypeBar({ onSend, onDone }: { readonly onSend: (text: string) => void; readonly onDone: () => void }) {
  const [draft, setDraft] = useState("");
  const send = () => {
    onSend(draft);
    setDraft("");
  };
  return (
    <GlassSurface className="flex-row items-center gap-1 rounded-full p-1 pl-4">
      <TextInput
        accessibilityLabel="Type on the device"
        autoFocus
        placeholder="Type on the device"
        placeholderTextColorClassName="accent-placeholder"
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={send}
        returnKeyType="send"
        autoCapitalize="none"
        autoCorrect={false}
        className="h-10 min-w-0 flex-1 text-base text-foreground"
      />
      <ControlPill icon="arrow.up" accessibilityLabel="Send text" disabled={!draft} onPress={send} />
      <ControlPill icon="xmark" accessibilityLabel="Stop typing" onPress={onDone} />
    </GlassSurface>
  );
}

function DeviceOptionsMenu({ items }: { readonly items: ReadonlyArray<ScreenHeaderMenuItem> }) {
  return (
    <ControlPillMenu
      actions={menuActionsFromItems(items)}
      isAnchoredToRight
      title="Device options"
      onPressAction={({ nativeEvent }) => {
        const action = findMenuItem(items, nativeEvent.event);
        if (action && !action.disabled) action.onPress();
      }}
    >
      <ControlPill icon="ellipsis" accessibilityLabel="Device options" />
    </ControlPillMenu>
  );
}

function OpenDevicePreview({
  hostId,
  preview: { preview, kind },
  enabled,
  onTakeControl,
  streamRef,
  onStreamingChange,
}: {
  readonly hostId: string;
  readonly preview: ThreadDevicePreview;
  readonly enabled: boolean;
  readonly onTakeControl: () => Promise<boolean>;
  readonly streamRef: RefObject<DeviceStreamRef | null>;
  readonly onStreamingChange: (streaming: boolean) => void;
}) {
  const { themeVariables } = useAppearancePreferences();
  return (
    <DeviceStreamWebView
      ref={streamRef}
      hostId={hostId}
      target={{ deviceHostId: preview.deviceHostId, deviceId: preview.deviceId }}
      platform={preview.platform}
      kind={kind}
      enabled={enabled}
      onTakeControl={onTakeControl}
      colors={{ background: themeVariables["--color-sheet-solid"], muted: themeVariables["--color-foreground-muted"] }}
      onStreamingChange={onStreamingChange}
    />
  );
}
