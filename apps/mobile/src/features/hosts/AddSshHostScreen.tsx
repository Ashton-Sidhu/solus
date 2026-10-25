import { ActivityIndicator, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";
import { SettingsChoiceRow } from "../settings/components/SettingsChoiceRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { sshProgressLines } from "./lib/ssh-add";
import { useSshAdd } from "./use-ssh-add";

/**
 * Adds a machine over SSH (docs/plans/host-routes.md D6, D7). A phone cannot
 * run SSH, so a connected host runs it: linked to the account, the machine is
 * reachable from every device; not linked, only from the host that ran SSH.
 */
export function AddSshHostScreen({ navigation, route }: ScreenProps<"AddSshHost">) {
  const insets = useSafeAreaInsets();
  const add = useSshAdd(route.params?.viaHostId);
  const { phase, runner } = add;
  const runnerLabel = runner?.label ?? "the host";
  const showsForm = phase.kind === "form" || phase.kind === "ask-auth" || phase.kind === "ask-target";

  return (
    <SettingsScreen title="Add over SSH">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {showsForm ? (
          <>
            <View className="gap-3">
              <SettingsSection title="Runs SSH">
                {add.runners.map((host, index) => (
                  <SettingsChoiceRow
                    key={host.hostId}
                    separated={index > 0}
                    label={host.label}
                    selected={host.hostId === runner?.hostId}
                    onPress={() => add.chooseRunner(host.hostId)}
                  />
                ))}
              </SettingsSection>
              <SettingsNote>
                {add.runners.length === 0
                  ? "Connect a computer running Solus first. This phone cannot run SSH; a connected host runs it, with its own SSH keys and ~/.ssh/config."
                  : `This phone cannot run SSH. ${runnerLabel} runs it, with its own SSH keys and ~/.ssh/config.`}
              </SettingsNote>
            </View>

            <ConnectionFormField
              label="SSH target"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="user@machine or an alias"
              returnKeyType="go"
              value={add.sshTarget}
              onChangeText={add.setSshTarget}
              onSubmitEditing={() => void add.submit()}
            />

            {phase.kind === "ask-target" && phase.candidates.length > 0 ? (
              <SettingsSection title="Targets from SSH">
                {phase.candidates.map((candidate, index) => (
                  <SettingsChoiceRow
                    key={candidate.target}
                    separated={index > 0}
                    label={candidate.label}
                    description={candidate.target}
                    selected={candidate.target === add.sshTarget}
                    onPress={() => add.setSshTarget(candidate.target)}
                  />
                ))}
              </SettingsSection>
            ) : null}

            <View className="gap-3">
              <SettingsSection>
                <SettingsSwitchRow
                  icon="link"
                  label="Link to my Solus account"
                  value={add.shouldLink}
                  disabled={!add.signedIn}
                  onValueChange={add.setShouldLink}
                />
              </SettingsSection>
              {add.signedIn ? (
                <SettingsNote>
                  {add.shouldLink
                    ? "Every device you sign in on reaches the machine through your account."
                    : `Only ${runnerLabel} reaches the machine, through an SSH forward. It needs an SSH key.`}
                </SettingsNote>
              ) : (
                <SettingsSection>
                  <SettingsRow
                    icon="person.crop.circle"
                    label="Sign in to link it to your account"
                    onPress={() => navigation.navigate("CloudSignIn")}
                  />
                </SettingsSection>
              )}
            </View>

            {add.shouldLink ? (
              <ConnectionFormField
                label="Password or key passphrase (optional)"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                textContentType="password"
                placeholder="Only when SSH asks"
                value={add.authSecret}
                onChangeText={add.setAuthSecret}
              />
            ) : null}

            {phase.kind === "ask-auth" || phase.kind === "ask-target" ? <ErrorBanner message={phase.message} /> : null}
            {add.error ? <ErrorBanner message={add.error} /> : null}

            <View className="android:flex-row android:justify-end">
              <ConnectionSheetButton
                icon="arrow.right"
                label={phase.kind === "form" ? "Add machine" : "Try again"}
                tone="primary"
                disabled={add.issue !== null}
                onPress={() => void add.submit()}
              />
            </View>
          </>
        ) : phase.kind === "running" ? (
          <View className="gap-3">
            <SettingsSection title={`${runnerLabel} is adding the machine`}>
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
            <SettingsNote>This can take a few minutes when Solus installs on the machine.</SettingsNote>
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
