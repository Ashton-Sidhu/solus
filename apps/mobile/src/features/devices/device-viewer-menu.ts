import type { DeviceButton, DeviceState } from "@solus/contracts/device-types";

import type { ScreenHeaderMenuItem } from "../../components/ScreenHeader.types";
import type { ThreadDevicePreview } from "./threadDevicePreviews";

/** What the device viewer knows when it builds its options menu. */
export interface DeviceViewerFacts {
  readonly previews: ReadonlyArray<ThreadDevicePreview>;
  readonly selected: ThreadDevicePreview;
  readonly state: DeviceState | undefined;
  readonly ownsControl: boolean;
  readonly agentPaused: boolean;
  /** Streaming while this viewer holds control: only then does input reach the device. */
  readonly inputConnected: boolean;
  readonly busy: boolean;
}

export interface DeviceViewerCommands {
  readonly select: (deviceKey: string) => void;
  readonly retryHost: (deviceHostId: string) => void;
  readonly toggleControl: () => void;
  readonly resumeAgent: () => void;
  readonly reloadStream: () => void;
  readonly press: (button: DeviceButton | "rotate") => void;
  readonly startTyping: () => void;
  readonly screenshot: () => void;
  readonly close: () => void;
  readonly shutdown: () => void;
}

/** T3's device options menu, with the Solus control lease, agent pause, screenshot, and pool return. */
export function deviceViewerMenuItems(facts: DeviceViewerFacts, commands: DeviceViewerCommands): ScreenHeaderMenuItem[] {
  return [...deviceItems(facts, commands), ...hostItems(facts, commands), ...controlItems(facts, commands), ...inputItems(facts, commands), ...previewItems(facts, commands)];
}

function deviceItems(facts: DeviceViewerFacts, commands: DeviceViewerCommands): ScreenHeaderMenuItem[] {
  if (facts.previews.length < 2) return [];
  return [
    {
      id: "devices",
      title: "Devices",
      inline: true,
      items: facts.previews.map((device) => ({
        id: device.key,
        title: device.name,
        subtitle: device.description,
        selected: device.key === facts.selected.key,
        onPress: () => commands.select(device.key),
      })),
    },
  ];
}

function hostItems(facts: DeviceViewerFacts, commands: DeviceViewerCommands): ScreenHeaderMenuItem[] {
  return (facts.state?.hostStatuses ?? [])
    .filter((entry) => entry.status === "failed")
    .map((entry) => ({
      id: `retry-${entry.deviceHostId}`,
      title: `Retry ${facts.state?.hosts.find((host) => host.deviceHostId === entry.deviceHostId)?.label ?? "device host"}`,
      icon: "arrow.clockwise",
      onPress: () => commands.retryHost(entry.deviceHostId),
    }));
}

function controlItems(facts: DeviceViewerFacts, commands: DeviceViewerCommands): ScreenHeaderMenuItem[] {
  const control: ScreenHeaderMenuItem = {
    id: "control",
    title: facts.ownsControl ? "Release control" : "Take control",
    icon: facts.ownsControl ? "hand.raised.slash" : "hand.raised",
    disabled: facts.busy,
    onPress: commands.toggleControl,
  };
  const resume: ScreenHeaderMenuItem = { id: "resume", title: "Resume agent", icon: "play", disabled: facts.busy, onPress: commands.resumeAgent };
  const reload: ScreenHeaderMenuItem = { id: "reload", title: "Reload stream", icon: "arrow.clockwise", onPress: commands.reloadStream };
  return facts.agentPaused ? [control, resume, reload] : [control, reload];
}

function inputItems(facts: DeviceViewerFacts, commands: DeviceViewerCommands): ScreenHeaderMenuItem[] {
  const disabled = !facts.inputConnected;
  const android = facts.selected.preview.platform === "android";
  const items: ScreenHeaderMenuItem[] = [];
  if (android) items.push({ id: "back", title: "Back", icon: "arrow.left", disabled, onPress: () => commands.press("back") });
  items.push({ id: "app-switcher", title: "App switcher", icon: "square.on.square", disabled, onPress: () => commands.press(android ? "recents" : "appSwitcher") });
  if (!android) items.push({ id: "rotate", title: "Rotate device", icon: "rotate.right", disabled, onPress: () => commands.press("rotate") });
  items.push({ id: "type", title: "Type text", icon: "keyboard", disabled, onPress: commands.startTyping });
  return items;
}

function previewItems(facts: DeviceViewerFacts, commands: DeviceViewerCommands): ScreenHeaderMenuItem[] {
  // A cloud pool device goes back to the pool when its preview closes, and its host takes no screenshot.
  const pooled = facts.selected.kind === "simlock";
  const items: ScreenHeaderMenuItem[] = [];
  if (!pooled) items.push({ id: "screenshot", title: "Screenshot", icon: "camera", disabled: facts.busy, onPress: commands.screenshot });
  items.push(
    { id: "close", title: pooled ? "Return to pool" : "Close preview", icon: "xmark", disabled: facts.busy, onPress: commands.close },
    // The host shuts a device down only for the holder of its control lease.
    { id: "shutdown", title: "Shut down device", icon: "power", destructive: true, disabled: facts.busy || !facts.ownsControl, onPress: commands.shutdown },
  );
  return items;
}
