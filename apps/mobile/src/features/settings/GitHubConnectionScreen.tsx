// Adapted from T3 Code apps/mobile/src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx (MIT, see UPSTREAM.md).
import { Alert, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useApp } from "../../app/app-context";
import type { ScreenProps } from "../../navigation/routes";
import { CODE_FONT } from "../../theme/tokens";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsValueRow } from "./components/SettingsValueRow";
import { accountConnectionValue } from "./lib/account-connections";
import { useGithubConnection } from "./use-github-connection";

/**
 * Connect, watch, or disconnect the host's GitHub account. A signed-in person's
 * connection is in their Solus account: the screen shows its status there and
 * opens the account's Connections page.
 */
export function GitHubConnectionScreen({ route }: ScreenProps<"GitHubConnection">) {
  const { hostId } = route.params;
  const app = useApp();
  const insets = useSafeAreaInsets();
  const { view, refresh, connect, cancel, disconnect } = useGithubConnection(hostId);

  const confirmDisconnect = () =>
    Alert.alert(
      "Disconnect GitHub?",
      "This host stops reading pull requests until GitHub is connected again. Every device that uses the host is affected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () =>
            void disconnect().catch((cause: unknown) =>
              Alert.alert(
                "Not disconnected",
                cause instanceof Error ? cause.message : String(cause),
              ),
            ),
        },
      ],
    );

  return (
    <SettingsScreen title="GitHub">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={view.kind === "loading"} onRefresh={refresh} />}
      >
        <View className="gap-3">
          {view.kind === "account" ? (
            <>
              <SettingsSection title="GitHub">
                <SettingsValueRow
                  icon={view.status?.kind === "connected" ? "person.crop.circle" : "info.circle"}
                  label="Status"
                  value={accountConnectionValue(view.status)}
                />
                <SettingsActionRow
                  icon="arrow.up.right"
                  label="Connect on your account"
                  onPress={() => void app.platform.openBrowser(view.url)}
                />
              </SettingsSection>
              {view.status?.kind === "failed" ? (
                <SettingsNote tone="danger">{view.status.message}</SettingsNote>
              ) : null}
              <SettingsNote>
                Your GitHub connection is in your Solus account. Every host you use reads it from
                there.
              </SettingsNote>
            </>
          ) : view.kind === "connecting" ? (
            <>
              <SettingsSection title="Sign in to GitHub">
                {view.prompt ? (
                  <View className="items-center gap-2 p-4">
                    <Text
                      selectable
                      accessibilityLabel={`Code ${view.prompt.userCode.split("").join(" ")}`}
                      className="text-3xl tracking-[4px] text-foreground"
                      style={{ fontFamily: CODE_FONT }}
                    >
                      {view.prompt.userCode}
                    </Text>
                    <Text selectable className="text-sm text-foreground-muted">
                      {view.prompt.verificationUri}
                    </Text>
                  </View>
                ) : (
                  <SettingsValueRow
                    icon="info.circle"
                    label="Status"
                    value="Asking GitHub for a code…"
                  />
                )}
                <SettingsActionRow icon="xmark" label="Cancel" tone="danger" onPress={cancel} />
              </SettingsSection>
              <SettingsNote>
                Enter this code on the GitHub page that opened. This screen updates when GitHub
                confirms.
              </SettingsNote>
            </>
          ) : (
            <SettingsSection title="GitHub">
              {view.kind === "connected" ? (
                <>
                  <SettingsValueRow
                    icon="person.crop.circle"
                    label="Account"
                    value={view.login ?? "Connected"}
                  />
                  <SettingsActionRow
                    icon="link"
                    label="Disconnect"
                    tone="danger"
                    onPress={confirmDisconnect}
                  />
                </>
              ) : (
                <>
                  <SettingsValueRow
                    icon="info.circle"
                    label="Status"
                    value={
                      view.kind === "loading"
                        ? "Checking…"
                        : view.kind === "error"
                          ? "Unavailable"
                          : "Not connected"
                    }
                  />
                  <SettingsActionRow
                    icon="link"
                    label="Connect GitHub"
                    disabled={view.kind === "loading"}
                    onPress={() => void connect()}
                  />
                </>
              )}
            </SettingsSection>
          )}
          {view.kind === "error" ? <SettingsNote tone="danger">{view.message}</SettingsNote> : null}
          {view.kind !== "account" ? (
            <SettingsNote>The host keeps the GitHub token. This device never holds it.</SettingsNote>
          ) : null}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}
