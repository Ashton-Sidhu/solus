import type { DeviceServiceState } from "@t3tools/contracts";

/** Host identity is part of the selection because Android serials repeat across hosts. */
export function threadDevicePreviews<
  K extends DeviceServiceState["hosts"][number]["kind"],
  S extends {
    threadId: string;
    hostId: string;
    deviceId: string;
    platform: "ios" | "android";
  },
>(
  state: {
    sessions: readonly S[];
    devices: readonly Pick<
      DeviceServiceState["devices"][number],
      "hostId" | "id" | "name" | "version"
    >[];
    hosts: readonly { id: string; label: string; kind: K }[];
  } | null,
  threadId: string,
) {
  return (state?.sessions ?? [])
    .filter((session) => session.threadId === threadId)
    .map((session) => {
      const device = state?.devices.find(
        (device) => device.hostId === session.hostId && device.id === session.deviceId,
      );
      const host = state?.hosts.find((host) => host.id === session.hostId);
      return {
        key: JSON.stringify([session.hostId, session.deviceId]),
        session,
        name: device?.name ?? (session.platform === "ios" ? "iOS Simulator" : "Android Emulator"),
        description: [device?.version, host?.label].filter(Boolean).join(" · "),
        hostKind: host?.kind,
        serveSimOnly: host?.kind === "simlock",
      };
    });
}

export type ThreadDevicePreview = ReturnType<
  typeof threadDevicePreviews<
    DeviceServiceState["hosts"][number]["kind"],
    DeviceServiceState["sessions"][number]
  >
>[number];

export function selectedThreadDevicePreview<T extends { key: string }>(
  previews: ReadonlyArray<T>,
  selectedKey: string | null | undefined,
) {
  return previews.find((preview) => preview.key === selectedKey) ?? previews[0] ?? null;
}
