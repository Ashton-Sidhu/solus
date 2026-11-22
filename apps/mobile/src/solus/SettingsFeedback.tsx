import { useState, useRef } from "react";
import { Alert } from "react-native";
import { AppText } from "../components/ui/AppText";

export function Note({ children }: { children: React.ReactNode }) {
  return <AppText className="px-4 py-3 text-foreground-muted">{children}</AppText>;
}
export function useSettingsAction(refresh?: () => void) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async (action: () => Promise<unknown>) => {
      if (lock.current) return;
      lock.current = true;
      setBusy(true);
      try {
        await action();
        refresh?.();
      } catch (error) {
        Alert.alert("Could not complete action", String(error));
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
  };
}
