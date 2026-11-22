import { useEffect } from "react";
import type { DeviceTarget } from "@solus/contracts/device-types";
import { solus as app } from "../runtime";
const CONTROL_RENEW_MS = 10_000;
export function useDeviceControlRenewal(
  hostId: string,
  sessionId: string,
  held: DeviceTarget | undefined,
) {
  const deviceHostId = held?.deviceHostId;
  const deviceId = held?.deviceId;
  useEffect(() => {
    if (deviceHostId === undefined || deviceId === undefined) return;
    const target = { deviceHostId, deviceId };
    const timer = setInterval(() => {
      if (app.devices.holdsControl(hostId, target))
        void app.devices.takeControl(hostId, target, sessionId).catch(() => {});
    }, CONTROL_RENEW_MS);
    return () => {
      clearInterval(timer);
      if (app.devices.holdsControl(hostId, target))
        void app.devices.release(hostId, target).catch(() => {});
    };
  }, [app, hostId, sessionId, deviceHostId, deviceId]);
}
