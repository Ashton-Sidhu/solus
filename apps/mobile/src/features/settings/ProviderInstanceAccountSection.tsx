import { useState } from "react";
import { Alert, Linking, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { providerStatusCheckedLabel, providerStatusLabel } from "@solus/client-core/provider-instances";
import type { ProviderInstancesClient, ProviderInstancesView } from "@solus/client-core/provider-instances";
import { AppText } from "../../components/AppText";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsValueRow } from "./components/SettingsValueRow";
import { SettingsNote } from "./components/SettingsNote";

export function ProviderInstanceAccountSection({ instanceId, client, view }: { instanceId: string; client: ProviderInstancesClient; view: ProviderInstancesView }) {
  const status = view.statuses.get(instanceId);
  const verification = view.verification?.instanceId === instanceId ? view.verification.result : null;
  const [code, setCode] = useState("");
  const [reveal, setReveal] = useState(false);
  return <View className="gap-3">
    <SettingsSection title="Status and account">
      <SettingsValueRow icon="checkmark" label="Status" value={providerStatusLabel(status)} />
      {status?.version ? <SettingsValueRow icon="info.circle" label="Version" value={status.version} /> : null}
      {status?.account ? <SettingsActionRow icon="person.crop.circle" label={reveal ? status.account : "Show account details"} onPress={() => setReveal(!reveal)} /> : null}
      <SettingsActionRow icon="arrow.clockwise" label="Refresh status" onPress={() => { void client.inspect(instanceId); }} />
      <SettingsActionRow icon="person.crop.circle" label={status?.authenticated ? "Change account" : "Sign in"} disabled={view.action !== null || status?.phase === "connecting"} onPress={() => { void client.signIn(instanceId); }} />
      {status?.authenticated ? <SettingsActionRow icon="person.crop.circle" label="Sign out" disabled={view.action !== null} onPress={() => Alert.alert("Sign out of this provider account?", "Other instances that use the same provider home share this login. New turns need a valid login.", [{ text: "Cancel", style: "cancel" }, { text: "Sign out", style: "destructive", onPress: () => { void client.signOut(instanceId); } }])} /> : null}
    </SettingsSection>
    {status ? <SettingsNote>{providerStatusCheckedLabel(status.checkedAt)}</SettingsNote> : null}
    {status?.error ? <SettingsNote>{status.error}</SettingsNote> : null}
    {verification ? <InstanceSignIn verification={verification} code={code} setCode={setCode} client={client} instanceId={instanceId} /> : null}
  </View>;
}

function InstanceSignIn({ verification, code, setCode, client, instanceId }: { verification: NonNullable<ProviderInstancesView["verification"]>["result"]; code: string; setCode: (value: string) => void; client: ProviderInstancesClient; instanceId: string }) {
  return <SettingsSection title="Finish sign-in">
      <SettingsActionRow icon="arrow.up.right" label="Open sign-in page" onPress={() => { void Linking.openURL(verification.verificationUrl); }} />
      <SettingsActionRow icon="doc.on.doc" label="Copy sign-in link" onPress={() => { void Clipboard.setStringAsync(verification.verificationUrl); }} />
      {verification.userCode ? <SettingsValueRow icon="checkmark" label="Device code" value={verification.userCode} /> : null}
      {verification.requiresCodeInput ? <View className="gap-3 px-4 py-3"><AppText className="text-base text-foreground">Sign-in code</AppText><TextInput accessibilityLabel="Provider sign-in code" value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} className="min-h-10 rounded-lg border border-border bg-input px-3 py-2 text-base text-foreground" /><SettingsActionRow icon="checkmark" label="Submit code" disabled={!code.trim()} onPress={() => { void client.submitCode(instanceId, code); }} /></View> : null}
      <SettingsActionRow icon="xmark" label="Cancel sign-in" onPress={() => { void client.cancelSignIn(instanceId); }} />
    </SettingsSection>;
}
