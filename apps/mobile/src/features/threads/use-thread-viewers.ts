import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect } from "react";
import { Keyboard } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import type { RootStackParamList } from "../../navigation/routes";
import { threadDevicePreviews } from "../devices/threadDevicePreviews";

/**
 * T3's preview segment of the floating control: the devices this session
 * shows, and the browser pages on its host. Only the counts are read, so a
 * page or device event re-renders the thread only when a count changes.
 */
export function useThreadViewers(hostId: string, sessionId: string, isHostReady: boolean) {
  const app = useApp();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const deviceCount = useListened(app.devices.changes, () => threadDevicePreviews(app.devices.stateOf(hostId), sessionId).length);
  const browserPageCount = useListened(app.browser.changes, () => app.browser.pagesOf(hostId).length);
  useEffect(() => {
    if (!isHostReady) return;
    void app.devices.load(hostId);
    void app.browser.load(hostId);
  }, [app, hostId, isHostReady]);
  const openDevicePreview = () => {
    Keyboard.dismiss();
    navigation.navigate("ThreadDevicePreview", { hostId, sessionId });
  };
  const openBrowserPreview = (browserPageId?: string) => {
    Keyboard.dismiss();
    navigation.navigate("ThreadBrowserPreview", { hostId, sessionId, browserPageId });
  };
  return {
    devicePreview: isHostReady && deviceCount > 0 ? { count: deviceCount, onPress: openDevicePreview } : null,
    browserPreview: isHostReady && browserPageCount > 0 ? { count: browserPageCount, onPress: () => openBrowserPreview() } : null,
    openBrowserPreview,
  };
}
