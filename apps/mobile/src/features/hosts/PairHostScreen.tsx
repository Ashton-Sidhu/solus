// Adapted from T3 Code apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useCallback, useRef, useState } from "react";
import { Alert, Linking, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { ScreenProps } from "../../navigation/routes";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import {
  decodePairInput,
  decodeScannedCode,
  pairFailureMessage,
  type HostPreview,
  type PairInput,
} from "./lib/pair-input";

/**
 * Pair with a host by its QR code, its pairing link, or its address and code
 * (plan 017 stage 2). The camera is asked for only when scanning is chosen,
 * and the host is shown before the device pairs with it: T3 connects at once,
 * Solus asks the person to trust the host first. Decoding and pairing are
 * Solus's own `/pair` flow.
 */
export function PairHostScreen({ navigation }: ScreenProps<"PairHost">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [hostInput, setHostInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [label, setLabel] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [target, setTarget] = useState<{
    preview: HostPreview;
    pairToken: string | null;
  } | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scannerLocked = useRef(false);

  const headerIconColor = useUniwindTheme()["--color-icon"];

  const inspect = useCallback(
    async (input: PairInput) => {
      if (input.kind === "invalid") {
        setError(input.message);
        return;
      }
      setIsSubmitting(true);
      setError(null);
      const result = await app.preview(input.url);
      setIsSubmitting(false);
      if (result.kind === "unreachable") {
        setError(
          "The host did not answer. Check the address and that this device is on a network that can reach it.",
        );
        return;
      }
      if (result.kind === "not-solus") {
        setError("A server answered at this address, but it is not a Solus host.");
        return;
      }
      setTarget({ preview: result.preview, pairToken: input.pairToken });
    },
    [app],
  );

  const openScanner = useCallback(async () => {
    if (cameraPermission?.granted) {
      scannerLocked.current = false;
      setShowScanner(true);
      return;
    }

    const permission = await requestCameraPermission();
    if (permission.granted) {
      scannerLocked.current = false;
      setShowScanner(true);
      return;
    }

    if (permission.canAskAgain) {
      Alert.alert("Camera access needed", "Allow camera access to scan a host's pairing code.");
      return;
    }

    Alert.alert(
      "Camera access needed",
      "Camera access was denied for Solus. Open Settings to enable it, or type the address and code.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  }, [cameraPermission?.granted, requestCameraPermission]);

  const closeScanner = useCallback(() => {
    setShowScanner(false);
    scannerLocked.current = false;
  }, []);

  const handleQrScan = useCallback(
    ({ data }: { readonly data: string }) => {
      if (scannerLocked.current) {
        return;
      }
      scannerLocked.current = true;
      setShowScanner(false);
      void inspect(decodeScannedCode(data));
    },
    [inspect],
  );

  const pair = useCallback(async () => {
    if (!target?.pairToken) {
      setError("Enter the pairing code the host shows.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await app.pair(target.preview, target.pairToken, label.trim() || undefined);
      navigation.reset({ index: 0, routes: [{ name: "Home" }] });
    } catch (failure) {
      setError(pairFailureMessage(failure instanceof Error ? failure : new Error(String(failure))));
    } finally {
      setIsSubmitting(false);
    }
  }, [app, label, navigation, target]);

  const connectDisabled = isSubmitting || hostInput.trim().length === 0;

  return (
    <SettingsScreen
      formSheet
      title={showScanner ? "Scan QR Code" : target ? "Pair Host" : "Add Host"}
      actions={
        target
          ? []
          : [
              {
                accessibilityLabel: showScanner ? "Close scanner" : "Scan QR code",
                icon: showScanner
                  ? "xmark"
                  : Platform.OS === "ios"
                    ? "qrcode.viewfinder"
                    : "camera",
                tintColor: headerIconColor,
                onPress: () => {
                  if (showScanner) {
                    closeScanner();
                  } else {
                    void openScanner();
                  }
                },
              },
            ]
      }
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        <View collapsable={false} className="gap-5">
          {target ? (
            <View collapsable={false} className="gap-4 rounded-[24px] bg-grouped-card p-4">
              <View className="gap-1">
                <Text className="text-lg font-t3-bold text-foreground" accessibilityRole="header">
                  {target.preview.name}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {target.preview.host}
                  {target.preview.os ? ` · ${target.preview.os}` : ""}
                </Text>
                <Text className="text-xs leading-normal text-foreground-muted">
                  Pair only with a host you trust. It will run agents for this device.
                </Text>
              </View>

              {target.pairToken === null ? (
                <ConnectionFormField
                  label="Pairing code"
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="Shown on the host"
                  value={codeInput}
                  onChangeText={(value) => {
                    setCodeInput(value);
                    setTarget({ ...target, pairToken: value.trim() || null });
                  }}
                />
              ) : null}

              <ConnectionFormField
                label="Name"
                autoCapitalize="words"
                autoCorrect={false}
                placeholder={target.preview.name}
                value={label}
                onChangeText={setLabel}
              />

              {error ? <ErrorBanner message={error} /> : null}

              <View className="gap-3 android:flex-row android:justify-end">
                <ConnectionSheetButton
                  icon="checkmark"
                  label={isSubmitting ? "Pairing…" : "Pair with this host"}
                  disabled={isSubmitting}
                  tone="primary"
                  onPress={() => {
                    void pair();
                  }}
                />
                <ConnectionSheetButton
                  icon="arrow.left"
                  label="Choose another host"
                  disabled={isSubmitting}
                  tone="secondary"
                  onPress={() => {
                    setTarget(null);
                    setError(null);
                  }}
                />
              </View>
            </View>
          ) : showScanner ? (
            cameraPermission?.granted ? (
              <View className="overflow-hidden rounded-[24px] border-continuous">
                <CameraView
                  accessibilityLabel="Camera viewfinder for the host's pairing code"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={handleQrScan}
                  style={{ aspectRatio: 1, width: "100%" }}
                />
              </View>
            ) : (
              <View className="items-center gap-3 rounded-[24px] border-continuous bg-grouped-card px-5 py-8">
                <Text className="text-center text-sm leading-normal text-foreground-muted">
                  Camera permission is required to scan a QR code.
                </Text>
                <ConnectionSheetButton
                  compact
                  icon="camera"
                  label="Allow camera"
                  tone="secondary"
                  onPress={() => {
                    void openScanner();
                  }}
                />
              </View>
            )
          ) : (
            <View collapsable={false} className="gap-4 rounded-[24px] bg-grouped-card p-4">
              <ConnectionFormField
                label="Host"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="Address or pairing link"
                returnKeyType="next"
                value={hostInput}
                onChangeText={setHostInput}
              />

              <ConnectionFormField
                label="Pairing code"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Shown on the host"
                returnKeyType="go"
                value={codeInput}
                onChangeText={setCodeInput}
                onSubmitEditing={() => {
                  if (!connectDisabled) void inspect(decodePairInput(hostInput, codeInput));
                }}
              />

              {error ? <ErrorBanner message={error} /> : null}

              <View className="android:flex-row android:justify-end">
                <ConnectionSheetButton
                  icon="plus"
                  label={isSubmitting ? "Checking…" : "Add host"}
                  disabled={connectDisabled}
                  tone="primary"
                  onPress={() => {
                    void inspect(decodePairInput(hostInput, codeInput));
                  }}
                />
              </View>
            </View>
          )}
          {!target && !showScanner ? (
            <SettingsNote>
              On the computer running Solus, open Settings → Connections → Pair a device. Scan its
              QR code with the camera button, or type the address and code it shows.
            </SettingsNote>
          ) : null}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}
