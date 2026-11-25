import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { ListChoiceRow } from "../components/ui/ListChoiceRow";
import { ListRow } from "../components/ui/ListRow";
import { ListToggleRow } from "../components/ui/ListToggleRow";
import { Sheet } from "../components/ui/Sheet";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { AddMachineSteps } from "../features/threads/AddMachineSteps";
import { KeyPermissionsFix } from "../features/threads/LinkRequestSshFields";
import { IdentityFileField } from "./IdentityFileField";
import { useAddOverSsh, useSshRunners, type AddOverSshFlow } from "./use-add-over-ssh";

/**
 * "Add over SSH" on the Add environment screen. A connected host that this
 * phone owns runs SSH, sets up Solus on the machine, and links it to the
 * account or holds a forward to it. Hidden when no such host is connected.
 */
export function AddOverSshRow(props: {
  readonly disabled: boolean;
  /** Signed out: the new host takes this person's server settings; null leaves them. */
  readonly syncSettings: boolean | null;
}) {
  const runners = useSshRunners();
  const [isOpen, setIsOpen] = useState(false);
  if (runners.length === 0 && !isOpen) return null;
  return (
    <>
      <View collapsable={false} className="overflow-hidden rounded-[26px] border-continuous bg-grouped-card">
        <ListRow
          label="Add over SSH"
          description="A computer running Solus sets up the machine with SSH."
          disabled={props.disabled}
          onPress={() => setIsOpen(true)}
        />
      </View>
      {isOpen ? <AddOverSshSheet syncSettings={props.syncSettings} onClose={() => setIsOpen(false)} /> : null}
    </>
  );
}

function AddOverSshSheet(props: { readonly syncSettings: boolean | null; readonly onClose: () => void }) {
  const flow = useAddOverSsh(props.syncSettings);
  const insets = useSafeAreaInsets();
  const isRunning = flow.phase === "running";
  return (
    <Sheet title="Add over SSH" onClose={props.onClose} dismissDisabled={isRunning}>
      <ScrollView
        nestedScrollEnabled
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        keyboardShouldPersistTaps="handled"
      >
        {flow.phase === "done" ? (
          <AddedNote flow={flow} onDone={props.onClose} />
        ) : (
          <>
            <SshAddFields flow={flow} disabled={isRunning} />
            <SshAddAnswers flow={flow} disabled={isRunning} />
            <Button
              label={isRunning ? "Adding…" : "Add"}
              tone="primary"
              disabled={
                isRunning ||
                !flow.runner ||
                !flow.sshTarget.trim() ||
                (flow.askAuth !== null && !flow.authSecret)
              }
              onPress={flow.add}
              fullWidth
            />
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

/** Run from, Target, Identity file, and the link switch. */
function SshAddFields(props: { readonly flow: AddOverSshFlow; readonly disabled: boolean }) {
  const { flow } = props;
  const runnerLabel = flow.runner?.label ?? "the host";
  return (
    <>
      <SettingsSection title="Run from">
        {flow.runners.map((host, index) => (
          <ListChoiceRow
            key={host.hostId}
            label={host.label}
            selected={flow.runner?.hostId === host.hostId}
            separated={index > 0}
            disabled={props.disabled}
            onPress={() => flow.chooseRunner(host.hostId)}
          />
        ))}
      </SettingsSection>
      <View className="gap-2">
        <Text className="px-1 text-sm font-t3-medium text-foreground-muted">Target</Text>
        <TextInput
          accessibilityLabel="SSH target"
          placeholder="ubuntu@3.91.20.4"
          value={flow.sshTarget}
          onChangeText={flow.setSshTarget}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          keyboardType="url"
          spellCheck={false}
        />
      </View>
      <IdentityFileField
        hostId={flow.runner?.hostId ?? null}
        hostLabel={runnerLabel}
        value={flow.identityFile}
        onChangeText={(value) => {
          flow.setIdentityFile(value);
          flow.clear();
        }}
        error={flow.identityError}
        disabled={props.disabled}
      />
      {flow.canLink ? (
        <View collapsable={false} className="overflow-hidden rounded-[26px] border-continuous bg-grouped-card">
          <ListToggleRow
            label="Link to my Solus account"
            description={`Your devices reach it through your account. Off: only ${runnerLabel} reaches it.`}
            disabled={props.disabled}
            value={flow.shouldLink}
            onValueChange={flow.setShouldLink}
          />
        </View>
      ) : null}
    </>
  );
}

/** The steps of the add, and what the host asks for next: a password, a key fix, or nothing. */
function SshAddAnswers(props: { readonly flow: AddOverSshFlow; readonly disabled: boolean }) {
  const { flow } = props;
  return (
    <>
      {flow.statusCard ? <AddMachineSteps card={flow.statusCard} /> : null}
      {flow.statusCard === null && flow.error !== null ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="px-1 text-sm text-danger-foreground">
          {flow.error}
        </Text>
      ) : null}
      {flow.keyFix !== null ? (
        <KeyPermissionsFix message={flow.keyFix} disabled={props.disabled} onFix={flow.fixKeyAndAdd} />
      ) : null}
      {flow.askAuth !== null ? (
        <View className="gap-2">
          <Text className="px-1 text-sm text-foreground-muted">{flow.askAuth}</Text>
          <TextInput
            accessibilityLabel={`SSH password for ${flow.sshTarget.trim()}`}
            placeholder="Password or key passphrase"
            value={flow.authSecret}
            onChangeText={flow.setAuthSecret}
            editable={!props.disabled}
            secureTextEntry
            autoCorrect={false}
            autoCapitalize="none"
            autoComplete="off"
            textContentType="none"
            spellCheck={false}
          />
        </View>
      ) : null}
    </>
  );
}

function AddedNote(props: { readonly flow: AddOverSshFlow; readonly onDone: () => void }) {
  return (
    <>
      {props.flow.statusCard ? <AddMachineSteps card={props.flow.statusCard} /> : null}
      <Text accessibilityLiveRegion="polite" className="px-1 text-sm text-foreground">
        {props.flow.note}
      </Text>
      <Button label="Done" tone="primary" onPress={props.onDone} fullWidth />
    </>
  );
}
