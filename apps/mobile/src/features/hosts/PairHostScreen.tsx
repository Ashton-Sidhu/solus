// Adapted from T3 Code apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking, Platform, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
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
import {
  isPairingBusy,
  OS_LABELS,
  pairedHoldMs,
  pairingPhase,
  type PairingStep,
} from "./lib/pairing-bridge";
import { NearbyHostsSection } from "./NearbyHostsSection";
import { PairingBridge } from "./PairingBridge";
import { nearbyHostUrl, useNearbyHosts } from "./use-nearby-hosts";

type PairTarget = { preview: HostPreview; pairToken: string | null };

/**
 * Pair with a host by its QR code, its pairing link, or its address and code
 * (plan 017 stage 2). The camera is asked for only when scanning is chosen,
 * and the host is shown before the device pairs with it: T3 connects at once,
 * Solus asks the person to trust the host first. Decoding and pairing are
 * Solus's own `/pair` flow. Hosts found on the local network are listed
 * above the form; a nearby host or a `link` param skips straight to the host.
 * A host that trusts this device by network position (`/health` says no auth)
 * pairs at once, with no confirm step.
 */
export function PairHostScreen({ navigation, route }: ScreenProps<"PairHost">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [hostInput, setHostInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [label, setLabel] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<PairingStep>("idle");
  const [target, setTarget] = useState<PairTarget | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scannerLocked = useRef(false);

  const headerIconColor = useUniwindTheme()["--color-icon"];
  const nearby = useNearbyHosts();
  const reduceMotion = useReducedMotion();
  const isBusy = isPairingBusy(step);

  // A failure stays on the host's page with the reason, so the person can add a code or try again.
  // Success holds the paired bridge for a moment, so the person sees it land before Home.
  const pairWith = useCallback(
    async (next: PairTarget, name: string | undefined) => {
      setTarget(next);
      setStep("pairing");
      setError(null);
      try {
        await app.pair(next.preview, next.pairToken ?? undefined, name);
      } catch (failure) {
        setStep("failed");
        setError(pairFailureMessage(failure instanceof Error ? failure : new Error(String(failure))));
        return;
      }
      setStep("paired");
      const hold = pairedHoldMs(reduceMotion);
      if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
      navigation.reset({ index: 0, routes: [{ name: "Home" }] });
    },
    [app, navigation, reduceMotion],
  );

  const inspect = useCallback(
    async (input: PairInput) => {
      if (input.kind === "invalid") {
        setError(input.message);
        return;
      }
      setStep("looking");
      setError(null);
      const result = await app.preview(input.url);
      setStep("idle");
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
      // A host that trusts this device's network pairs without a code: connect at once.
      if (result.preview.trusted && !input.pairToken) {
        await pairWith({ preview: result.preview, pairToken: null }, undefined);
        return;
      }
      setTarget({ preview: result.preview, pairToken: input.pairToken });
    },
    [app, pairWith],
  );

  const link = route.params?.link;
  useEffect(() => {
    if (link) void inspect(decodePairInput(link));
  }, [inspect, link]);

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
    if (!target) return;
    if (!target.pairToken && !target.preview.trusted) {
      setError("Enter the pairing code the host shows.");
      return;
    }
    await pairWith(target, label.trim() || undefined);
  }, [label, pairWith, target]);

  const connectDisabled = isBusy || hostInput.trim().length === 0;

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
          {showScanner && !target ? null : (
            <PairingBridge phase={pairingPhase(step, target !== null)} host={target?.preview ?? null} />
          )}
          {target ? (
            <View collapsable={false} className="gap-5">
              <PairTargetHeading preview={target.preview} />

              {target.pairToken === null && !target.preview.trusted ? (
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

              <View className="gap-2 android:flex-row android:justify-end">
                <ConnectionSheetButton
                  icon="checkmark"
                  label={pairActionLabel(step, target.preview, target.pairToken)}
                  disabled={isBusy}
                  tone="primary"
                  onPress={() => {
                    void pair();
                  }}
                />
                <ConnectionSheetButton
                  icon="arrow.left"
                  label="Choose another host"
                  disabled={isBusy}
                  tone="secondary"
                  onPress={() => {
                    setTarget(null);
                    setError(null);
                    setStep("idle");
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
              <View
                className="items-center gap-3 rounded-2xl border-composer-border px-5 py-8"
                style={{ borderWidth: StyleSheet.hairlineWidth }}
              >
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
            <>
              <NearbyHostsSection
                nearby={nearby}
                onSelect={(server) => void inspect(decodePairInput(nearbyHostUrl(server)))}
              />
              <View collapsable={false} className="gap-4">
                <Text className="text-sm font-t3-medium text-foreground-muted" accessibilityRole="header">
                  Enter an address
                </Text>
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
                    icon="arrow.right"
                    label={step === "looking" ? "Checking…" : "Continue"}
                    disabled={connectDisabled}
                    tone="primary"
                    onPress={() => {
                      void inspect(decodePairInput(hostInput, codeInput));
                    }}
                  />
                </View>
              </View>
            </>
          )}
          {!target && !showScanner ? (
            <ConnectionSheetButton
              icon="terminal"
              label="Add a machine over SSH"
              tone="secondary"
              onPress={() => navigation.navigate("AddSshHost")}
            />
          ) : null}
          {!target && !showScanner ? (
            <SettingsNote>
              On the computer running Solus, open Settings → Hosts → this computer → Access → Pairing. Scan its
              QR code with the camera button, or type the address and code it shows. A host that trusts your
              local network needs no code.
            </SettingsNote>
          ) : null}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

/** As the desktop pairing stage: the address over the host's name, then the one-line why. */
function PairTargetHeading({ preview }: { readonly preview: HostPreview }) {
  const address = preview.os ? `${preview.host} · ${OS_LABELS[preview.os]}` : preview.host;
  return (
    <View className="gap-1.5">
      <Text className="text-[13px] text-foreground-muted">{address}</Text>
      <Text className="text-[22px] leading-7 font-t3-medium text-foreground" accessibilityRole="header">
        {preview.name}
      </Text>
      <Text className="text-[15px] leading-normal text-foreground-muted">
        Pair only with a host you trust. It will run agents for this device.
      </Text>
    </View>
  );
}

function pairActionLabel(step: PairingStep, preview: HostPreview, pairToken: string | null): string {
  if (step === "paired") return "Paired";
  if (step === "pairing") return "Pairing…";
  return preview.trusted && !pairToken ? "Connect" : "Pair";
}
