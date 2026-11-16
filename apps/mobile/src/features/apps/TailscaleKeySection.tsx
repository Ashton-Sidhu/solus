import { useState } from "react";
import { Alert, TextInput, View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";

import { AppText as Text } from "../../components/AppText";
import { SettingsSection } from "../settings/components/SettingsSection";
import { errorMessage } from "../settings/integrations";
import { PillButton } from "../webhooks/webhook-rows";
import { AppStateMark } from "./app-rows";
import { useAppChange, useHostRead } from "./use-app";

const readPublishPlaces = (api: HostApi) => api.appPublishPlaces();

/**
 * The Tailscale auth key of a host (docs/plans/app-deploy.md §8.2): what a
 * published app with a Tailscale address joins the tailnet with. The owner
 * gives it in a masked field, replaces it, or removes it. A value is never
 * read back, so the row says only whether the host has one. A host that does
 * not publish apps shows nothing.
 */
export function TailscaleKeySection({ hostId }: { readonly hostId: string }) {
  const places = useHostRead(hostId, readPublishPlaces);
  const { busy, change } = useAppChange(hostId);
  const [draft, setDraft] = useState<string | null>(null);

  if (places.state.kind !== "loaded") return null;
  const hasKey = places.state.value.hasTailscaleKey;

  const save = (value: string | null) => {
    change("tailscale-key", (api) => api.appTailscaleKeySet({ value })).then(
      () => {
        setDraft(null);
        places.reload();
      },
      (cause: unknown) => Alert.alert(value === null ? "Not removed" : "Not saved", errorMessage(cause)),
    );
  };

  const remove = () => {
    Alert.alert("Remove the Tailscale auth key?", "A published app with a Tailscale address keeps its address until its container starts again.", [
      { text: "Keep", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => save(null) },
    ]);
  };

  return (
    <SettingsSection
      title="Published apps"
      footer="A published app with a Tailscale address joins your tailnet with this key. Make a reusable key in the Tailscale admin console. The key stays on this host and is never shown again."
    >
      <View className="gap-3 p-4">
        <View className="flex-row items-center gap-3">
          <View className="size-6 items-center justify-center">
            <AppStateMark mark={hasKey ? { state: "ok", label: "Saved" } : { state: "idle" }} />
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <Text className="text-base text-foreground">Tailscale auth key</Text>
            {hasKey ? null : <Text className="text-sm text-foreground-muted">Not set</Text>}
          </View>
        </View>
        {draft === null ? (
          <View className="flex-row flex-wrap gap-2 pl-9">
            <PillButton label={hasKey ? "Replace" : "Add key"} disabled={busy !== null} onPress={() => setDraft("")} />
            {hasKey ? <PillButton label="Remove" disabled={busy !== null} onPress={remove} /> : null}
          </View>
        ) : (
          <View className="gap-2">
            <TextInput
              accessibilityLabel="Tailscale auth key"
              autoFocus
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              placeholder="tskey-auth-…"
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={() => (draft.trim() ? save(draft.trim()) : undefined)}
              returnKeyType="done"
              className="min-h-12 rounded-2xl border border-border bg-input px-3.5 py-3 text-sm text-foreground"
            />
            <View className="flex-row gap-2">
              <PillButton label="Save" disabled={busy !== null || draft.trim() === ""} onPress={() => save(draft.trim())} />
              <PillButton label="Cancel" onPress={() => setDraft(null)} />
            </View>
          </View>
        )}
      </View>
    </SettingsSection>
  );
}
