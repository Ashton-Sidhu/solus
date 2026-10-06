// Adapted from T3 Code apps/mobile/src/features/cloud/ConnectOnboardingRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useEffect } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import type { ScreenProps } from "../../navigation/routes";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";
import { SettingsScreen } from "../settings/components/SettingsScreen";

/**
 * Sign in to Solus Cloud with the account's device flow: the approval page
 * opens in the system browser and this screen shows the code to confirm.
 * Leaving the app and returning resumes the same wait; an expired code ends
 * it. T3 signs in with Clerk's native views; Solus keeps its device flow in
 * T3's onboarding sheet.
 */
export function CloudSignInScreen({ navigation }: ScreenProps<"CloudSignIn">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const view = useListened(app.account.changes, () => app.account.view);

  useEffect(() => {
    if (view.kind === "signed-in") navigation.replace("CloudHosts");
  }, [navigation, view.kind]);

  return (
    <SettingsScreen title="Solus Cloud">
      <ScrollView
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          gap: 16,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        {view.kind === "signing-in" ? (
          <>
            <View
              collapsable={false}
              className="items-center gap-3 rounded-[24px] bg-grouped-card p-5"
            >
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                Confirm this code on the sign-in page:
              </Text>
              <Text
                selectable
                accessibilityLabel={`Code ${view.userCode.split("").join(" ")}`}
                className="text-3xl font-t3-bold tracking-[2px] text-foreground"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {view.userCode}
              </Text>
              <Text className="text-center text-xs leading-normal text-foreground-muted">
                Waiting for approval. You can switch apps; this screen continues when you return.
              </Text>
            </View>
            <ConnectionSheetButton
              icon="safari"
              label="Open sign-in page"
              tone="secondary"
              onPress={() => void app.platform.openBrowser(view.verificationUrl)}
            />
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => app.account.cancelSignIn()}
              className="items-center py-1 active:opacity-70"
            >
              <Text className="text-xs text-foreground-muted">Cancel</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View collapsable={false} className="rounded-[24px] bg-grouped-card p-5">
              <Text className="text-sm leading-normal text-foreground-muted">
                Sign in to reach the hosts your Solus account can use. Hosts you paired directly
                stay on this device either way.
              </Text>
            </View>
            {view.kind === "signed-out" && view.message ? (
              <ErrorBanner message={view.message} />
            ) : null}
            <ConnectionSheetButton
              icon="person.crop.circle"
              label={view.kind === "loading" ? "Checking..." : "Sign in"}
              disabled={view.kind === "loading"}
              tone="primary"
              onPress={() => void app.account.startSignIn()}
            />
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
