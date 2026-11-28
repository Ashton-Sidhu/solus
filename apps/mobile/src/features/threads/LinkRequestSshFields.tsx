import type { AddMachineAsk } from "@solus/contracts/add-machine";
import { OTHER_MACHINE } from "@solus-mobile/features/conversation/lib/add-machine-card";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { IdentityFileField } from "../../solus/IdentityFileField";
import { solus } from "../../solus/runtime";
import type { AddMachineFlow } from "./LinkRequestCard";

/** The typed SSH key, filled first from the agent's ask. */
export function useSshFields(ask: AddMachineAsk) {
  const [identityFile, setIdentityFile] = useState(ask.identityFile ?? "");
  // On an SSH config alias the key of ~/.ssh/config is used until the person asks for another.
  const [useAnotherKey, setUseAnotherKey] = useState(Boolean(ask.identityFile));
  // SSH refused a key that other users can read: Fix permissions, then the same add again.
  const [keyFix, setKeyFix] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  return {
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
 * The SSH key of the Add machine sheet. A target typed on "Other machine…"
 * takes an identity file. An SSH config alias uses the key that
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
  if (flow.selectedKey === OTHER_MACHINE) return identityField;
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
