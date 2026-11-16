// Adapted from T3 Code apps/mobile/src/features/devices/threadDevicePreviews.ts (MIT, see UPSTREAM.md).
import type { DeviceState } from "@solus/contracts/device-types";

/** The device host is part of the key because Android serials repeat across device hosts. */
export function threadDevicePreviews(state: DeviceState | undefined, sessionId: string) {
  return (state?.previews ?? [])
    .filter((preview) => preview.sessionId === sessionId)
    .map((preview) => {
      const device = state?.devices.find(
        (candidate) => candidate.deviceHostId === preview.deviceHostId && candidate.deviceId === preview.deviceId,
      );
      const host = state?.hosts.find((candidate) => candidate.deviceHostId === preview.deviceHostId);
      return {
        key: JSON.stringify([preview.deviceHostId, preview.deviceId]),
        preview,
        name: device?.name ?? (preview.platform === "ios" ? "iOS Simulator" : "Android Emulator"),
        description: [device?.version, host?.label].filter(Boolean).join(" · "),
        kind: host?.kind ?? "local",
      };
    });
}

export type ThreadDevicePreview = ReturnType<typeof threadDevicePreviews>[number];

export function selectedThreadDevicePreview(
  previews: ReadonlyArray<ThreadDevicePreview>,
  selectedKey: string | undefined,
) {
  return previews.find((preview) => preview.key === selectedKey) ?? previews[0] ?? null;
}
