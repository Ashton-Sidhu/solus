import { ActivityIndicator, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sshAddStatusCard } from "@solus/client-core/ssh-progress";
import { wslHostLabel } from "@solus/contracts/remote-machines";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { StageRow } from "../threads/WorktreeSetupCard";
import { useWslAdd } from "./use-wsl-add";

/**
 * Adds the WSL distro chosen in a Windows host's settings as a machine
 * (docs/plans/windows.md §5.13). The Windows host installs Solus in the distro,
 * reaches it, and keeps it running; a link to the account makes it reachable
 * from the phone too.
 */
export function AddWslHostScreen({ navigation, route }: ScreenProps<"AddWslHost">) {
  const insets = useSafeAreaInsets();
  const add = useWslAdd(route.params.hostId, route.params.distro);
  const { phase, hostLabel } = add;

  return (
    <SettingsScreen title={`Add ${wslHostLabel(route.params.distro)}`}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {phase.kind === "running" ? (
          <View className="gap-3">
            <SettingsSection title={`${hostLabel} is adding the distro`}>
              {phase.progress.length === 0 ? (
                <View className="flex-row items-center gap-3 p-4">
                  <ActivityIndicator accessibilityLabel="Starting" colorClassName="accent-icon-muted" />
                  <Text className="text-lg text-foreground">Starting</Text>
                </View>
              ) : (
                <View className="px-4 py-2">
                  {sshAddStatusCard(phase.progress, { target: wslHostLabel(route.params.distro), standing: "running", resultMessage: "", error: "" }).steps.map((step) => (
                    <StageRow key={step.id} step={step} compact />
                  ))}
                </View>
              )}
            </SettingsSection>
            <SettingsNote>This can take a few minutes the first time, while Solus installs in the distro.</SettingsNote>
          </View>
        ) : phase.kind === "failed" ? (
          <View className="gap-3">
            <ErrorBanner message={phase.message} />
            <View className="android:flex-row android:justify-end">
              <ConnectionSheetButton icon="arrow.clockwise" label="Try again" tone="primary" onPress={() => void add.retry()} />
            </View>
          </View>
        ) : (
          <View className="gap-5">
            <View className="gap-1.5">
              <Text className="text-[22px] leading-7 font-t3-medium text-foreground" accessibilityRole="header">
                {phase.kind === "forwarded" ? phase.host.label : phase.label}
              </Text>
              <Text className="text-[15px] leading-normal text-foreground-muted">{phase.note}</Text>
            </View>
            {add.error ? <ErrorBanner message={add.error} /> : null}
            <View className="gap-2 android:flex-row android:justify-end">
              {phase.kind === "forwarded" && add.signedIn ? (
                <ConnectionSheetButton
                  icon="link"
                  label={add.isLinking ? "Linking…" : "Link to my account"}
                  tone="primary"
                  disabled={add.isLinking}
                  onPress={() => void add.linkForwarded()}
                />
              ) : null}
              <ConnectionSheetButton
                icon="checkmark"
                label="Done"
                tone={phase.kind === "forwarded" && add.signedIn ? "secondary" : "primary"}
                disabled={add.isLinking}
                onPress={() => navigation.goBack()}
              />
            </View>
            {phase.kind === "forwarded" && !add.signedIn ? (
              <SettingsSection>
                <SettingsRow
                  icon="person.crop.circle"
                  label="Sign in to link it to your account"
                  onPress={() => navigation.navigate("CloudSignIn")}
                />
              </SettingsSection>
            ) : null}
          </View>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
