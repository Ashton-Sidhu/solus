import { ActivityIndicator, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";
import { SettingsChoiceRow } from "../settings/components/SettingsChoiceRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { sshProgressLines } from "./lib/ssh-add";
import { distroNote } from "./lib/wsl-add";
import { useWslAdd } from "./use-wsl-add";

/**
 * Adds a WSL distro of a Windows host as a machine (docs/plans/windows.md §13.6).
 * The Windows host installs Solus in the distro and reaches it; a link to the
 * account makes it reachable from the phone too.
 */
export function AddWslHostScreen({ navigation, route }: ScreenProps<"AddWslHost">) {
  const insets = useSafeAreaInsets();
  const add = useWslAdd(route.params.hostId);
  const { phase, hostLabel } = add;

  return (
    <SettingsScreen title="Add a WSL distro">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {phase.kind === "loading" ? (
          <View className="flex-row items-center gap-3 p-4">
            <ActivityIndicator accessibilityLabel="Reading the WSL distros" colorClassName="accent-icon-muted" />
            <Text className="text-lg text-foreground">Reading the WSL distros</Text>
          </View>
        ) : phase.kind === "form" ? (
          <>
            {phase.distros.length > 0 ? (
              <View className="gap-3">
                <SettingsSection title={`Distros on ${hostLabel}`}>
                  {phase.distros.map((distro, index) => (
                    <SettingsChoiceRow
                      key={distro.name}
                      separated={index > 0}
                      label={distro.name}
                      description={distroNote(distro)}
                      selected={distro.name === add.distro}
                      onPress={() => add.setDistro(distro.name)}
                    />
                  ))}
                </SettingsSection>
                <SettingsNote>
                  {`${hostLabel} installs Solus in the distro, so the distro needs nothing installed. Only ${hostLabel} reaches it until you link it to your account.`}
                </SettingsNote>
              </View>
            ) : null}
            {add.error ? <ErrorBanner message={add.error} /> : null}
            <View className="android:flex-row android:justify-end">
              <ConnectionSheetButton
                icon="arrow.right"
                label="Add distro"
                tone="primary"
                disabled={!add.distro}
                onPress={() => void add.submit()}
              />
            </View>
          </>
        ) : phase.kind === "running" ? (
          <View className="gap-3">
            <SettingsSection title={`${hostLabel} is adding the distro`}>
              {sshProgressLines(phase.progress).map((line) => (
                <View key={line.step} className="flex-row items-center gap-3 p-4">
                  {line.isCurrent ? (
                    <ActivityIndicator accessibilityLabel={line.title} colorClassName="accent-icon-muted" />
                  ) : null}
                  <View className="min-w-0 flex-1">
                    <Text className={line.isCurrent ? "text-lg text-foreground" : "text-lg text-foreground-muted"}>
                      {line.title}
                    </Text>
                    <Text className="text-xs text-foreground-muted">{line.message}</Text>
                  </View>
                </View>
              ))}
              {phase.progress.length === 0 ? (
                <View className="flex-row items-center gap-3 p-4">
                  <ActivityIndicator accessibilityLabel="Starting" colorClassName="accent-icon-muted" />
                  <Text className="text-lg text-foreground">Starting</Text>
                </View>
              ) : null}
            </SettingsSection>
            <SettingsNote>This can take a few minutes the first time, while Solus installs in the distro.</SettingsNote>
          </View>
        ) : phase.kind === "failed" ? (
          <ErrorBanner message={phase.message} />
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
