import type { AddMachineAsk } from "@solus/contracts/add-machine";
import { ANOTHER_SSH } from "@solus-mobile/features/conversation/lib/add-machine-card";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { IdentityFileField } from "../../solus/IdentityFileField";
import { solus } from "../../solus/runtime";
import type { AddMachineFlow } from "./LinkRequestCard";

/** The typed SSH target and key, filled first from the agent's ask. */
export function useSshFields(ask: AddMachineAsk) {
  const [sshTarget, setSshTarget] = useState(ask.sshTarget ?? "");
  const [identityFile, setIdentityFile] = useState(ask.identityFile ?? "");
  // On an SSH config alias the key of ~/.ssh/config is used until the person asks for another.
  const [useAnotherKey, setUseAnotherKey] = useState(Boolean(ask.identityFile));
  // SSH refused a key that other users can read: Fix permissions, then the same add again.
  const [keyFix, setKeyFix] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  return {
    sshTarget,
    setSshTarget,
    identityFile,
    setIdentityFile: (value: string) => {
      setIdentityFile(value);
      setIdentityError(null);
      setKeyFix(null);
    },
    useAnotherKey,
    setUseAnotherKey,
    keyFix,
    setKeyFix,
    identityError,
    setIdentityError,
  };
}

/** The key of an SSH step, and Fix permissions after SSH refused a key that other users can read. */
export function SshKeySection(props: { readonly flow: AddMachineFlow; readonly disabled: boolean }) {
  const { flow } = props;
  if (flow.step?.kind !== "ssh") return null;
  return (
    <>
      <SshKeyFields flow={flow} disabled={props.disabled} />
      {flow.ssh.keyFix ? (
        <KeyPermissionsFix message={flow.ssh.keyFix} disabled={props.disabled} onFix={flow.fixKeyAndAdd} />
      ) : null}
    </>
  );
}

/**
 * The SSH fields of the Add machine sheet. "Another machine over SSH…" takes a
 * target and an identity file. An SSH config alias uses the key that
 * `~/.ssh/config` names until the person chooses "Use another key…".
 */
function SshKeyFields(props: { readonly flow: AddMachineFlow; readonly disabled: boolean }) {
  const { flow } = props;
  const { ssh } = flow;
  const hostLabel = solus.registry.host(flow.sessionHostId)?.label ?? "the session's host";
  const identityField = (
    <IdentityFileField
      hostId={flow.sessionHostId}
      hostLabel={hostLabel}
      value={ssh.identityFile}
      onChangeText={ssh.setIdentityFile}
      error={ssh.identityError}
      disabled={props.disabled}
    />
  );
  if (flow.selectedKey === ANOTHER_SSH) {
    return (
      <View className="gap-4">
        <View className="gap-2">
          <Text className="px-1 text-sm font-t3-medium text-foreground-muted">Target</Text>
          <TextInput
            accessibilityLabel="SSH target"
            placeholder="ubuntu@3.91.20.4"
            value={ssh.sshTarget}
            onChangeText={ssh.setSshTarget}
            editable={!props.disabled}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            keyboardType="url"
            spellCheck={false}
          />
        </View>
        {identityField}
      </View>
    );
  }
  if (ssh.useAnotherKey) return identityField;
  return (
    <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1 px-1">
      <Text className="font-sans text-sm text-foreground-muted">Key: from ~/.ssh/config</Text>
      <Pressable
        accessibilityRole="button"
        disabled={props.disabled}
        hitSlop={8}
        className="active:opacity-60"
        onPress={() => ssh.setUseAnotherKey(true)}
      >
        <Text className="font-t3-bold text-sm text-foreground underline">Use another key…</Text>
      </Pressable>
    </View>
  );
}

/** SSH refused a key that other users can read. Fix permissions lets only its owner read it, then adds again. */
export function KeyPermissionsFix(props: {
  readonly message: string;
  readonly disabled: boolean;
  readonly onFix: () => void;
}) {
  return (
    <View className="gap-2">
      <Text
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        className="font-sans text-sm text-danger-foreground"
      >
        {props.message}
      </Text>
      <Button
        label="Fix permissions"
        tone="secondary"
        disabled={props.disabled}
        onPress={props.onFix}
        fullWidth
      />
    </View>
  );
}
