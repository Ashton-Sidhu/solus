import { useAtomSet } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { linkedEnvironmentPrefillAtom } from "../features/connection/linkedEnvironmentPrefill";
import { solus } from "./runtime";

export function useConnectSolusMachine() {
  const navigation = useNavigation();
  const setPrefill = useAtomSet(linkedEnvironmentPrefillAtom);
  const active = useRef(false);
  const cancel = useRef<AbortController | null>(null);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => () => cancel.current?.abort(), []);
  const connect = async (installationId: string, label: string, host: string | null, onConnected?: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    const attempt = new AbortController();
    cancel.current = attempt;
    setConnecting(true);
    try {
      const ready = () => solus.connections.state(installationId)?.readiness === "ready";
      if (ready() || await solus.connections.pairThroughKnownMachine(installationId)) {
        if (!attempt.signal.aborted && (ready() || await waitForConnection(ready, attempt.signal))) {
          if (!attempt.signal.aborted) await onConnected?.();
        } else if (!attempt.signal.aborted) Alert.alert("The paired machine did not connect.");
        return;
      }
      if (attempt.signal.aborted) return;
      const environmentId = EnvironmentId.make(installationId);
      setPrefill({ environmentId, label, host });
      navigation.navigate("ConnectionsNew", { linked: environmentId });
    } catch {
      if (!attempt.signal.aborted) Alert.alert("Could not connect to this machine.");
    } finally {
      active.current = false;
      cancel.current = null;
      if (!attempt.signal.aborted) setConnecting(false);
    }
  };
  return { connect, connecting };
}

function waitForConnection(ready: () => boolean, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const stop = solus.connections.changes.subscribe(() => { if (ready()) finish(true); });
    const timer = setTimeout(() => finish(false), 15_000);
    const abort = () => finish(false);
    function finish(connected: boolean) {
      stop();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(connected);
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || ready()) finish(!signal.aborted);
  });
}
