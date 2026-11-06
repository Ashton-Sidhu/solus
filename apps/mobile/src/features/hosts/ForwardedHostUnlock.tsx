import { useState } from "react";
import { View } from "react-native";

import { ConnectionFormField } from "../connection/ConnectionFormField";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsSection } from "../settings/components/SettingsSection";

/**
 * The password field of a forward in `needs-auth`
 * (docs/plans/ssh-forward-password.md). The host keeps the password in memory;
 * here it leaves the draft when it is sent.
 */
export function ForwardedHostUnlock(props: {
  readonly isBusy: boolean;
  /** Why a password cannot go to the host now, or null when it can. */
  readonly issue: string | null;
  readonly onUnlock: (authSecret: string) => void;
}) {
  const [password, setPassword] = useState("");
  if (props.issue) return <SettingsNote>{props.issue}</SettingsNote>;

  const send = () => {
    if (!password || props.isBusy) return;
    setPassword("");
    props.onUnlock(password);
  };

  return (
    <View className="gap-3">
      <ConnectionFormField
        label="Password or key passphrase"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        textContentType="password"
        returnKeyType="go"
        value={password}
        onChangeText={setPassword}
        onSubmitEditing={send}
      />
      <SettingsSection>
        <SettingsActionRow
          icon="lock.open"
          label="Connect"
          loading={props.isBusy}
          disabled={props.isBusy || !password}
          onPress={send}
        />
      </SettingsSection>
    </View>
  );
}
