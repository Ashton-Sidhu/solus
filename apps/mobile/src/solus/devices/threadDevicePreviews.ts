import type { DeviceState } from "@solus/contracts/device-types";
import { threadDevicePreviews as upstreamPreviews } from "../../features/devices/threadDevicePreviews";

export { selectedThreadDevicePreview } from "../../features/devices/threadDevicePreviews";

export function threadDevicePreviews(state: DeviceState | undefined, sessionId: string) {
  const devices = state && {
    sessions: state.previews.map((preview) => ({
      threadId: preview.sessionId,
      hostId: preview.deviceHostId,
      deviceId: preview.deviceId,
      platform: preview.platform,
      preview,
    })),
    hosts: state.hosts.map(({ deviceHostId: id, kind, label }) => ({ id, kind, label })),
    devices: state.devices.map(({ deviceHostId: hostId, deviceId: id, name, version }) => ({
      hostId,
      id,
      name,
      version,
    })),
  };
  return upstreamPreviews(devices ?? null, sessionId).map(
    ({ session, hostKind, name, description, key }) => ({
      preview: session.preview,
      kind: hostKind ?? ("local" as const),
      name,
      description,
      key,
    }),
  );
}

export type ThreadDevicePreview = ReturnType<typeof threadDevicePreviews>[number];
