import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import {
  agentProfileKeyOf,
  type AgentProfileKey,
} from "@solus/contracts/agent-profile";
import type { RemoteSkill } from "@solus/contracts/types";
import {
  entryKeyLabel,
  entryValueText,
  hostProfileText,
  modelInstructionChoices,
} from "@solus-mobile/features/settings/lib/agent-profile-entries";
import { SettingsPage, TextSetting } from "./SettingsPages";
import { AppText, AppTextInput } from "../components/ui/AppText";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { useAgentProfile } from "./use-agent-profile";

export function AgentProfileSettings() {
  const profile = useAgentProfile();
  const [query, setQuery] = useState("");
  const [address, setAddress] = useState("");
  const [modelId, setModelId] = useState("");
  const [results, setResults] = useState<RemoteSkill[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [checking, setChecking] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    setResults(null);
    setSearching(false);
    return () => {
      request.current++;
    };
  }, [profile.toolHost?.hostId, query]);
  async function findSkills() {
    const id = ++request.current;
    setSearching(true);
    try {
      const found = await profile.searchSkills(query.trim());
      if (request.current === id) setResults(found);
    } catch (error) {
      if (request.current === id)
        Alert.alert("Could not find skills", String(error));
    } finally {
      if (request.current === id) setSearching(false);
    }
  }
  const remove = (label: string, keys: AgentProfileKey[]) =>
    Alert.alert(
      "Remove " + label + "?",
      "This removes the entry from your synced profile.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => profile.removeKeys(keys),
        },
      ],
    );
  const entries = [
    ...profile.parts.handWrittenSkills.map((s) => ({
      label: s.name,
      keys: s.keys,
    })),
    ...[
      ...profile.parts.registrySkills,
      ...profile.parts.integrations,
      ...profile.parts.files,
    ].map((entry) => {
      const key = agentProfileKeyOf(entry);
      return { label: entryKeyLabel(key), keys: [key] };
    }),
  ];
  return (
    <SettingsPage title="Agent profile">
      <SettingsSection title="Profile entries">
        {entries.length === 0 && (
          <AppText className="px-4 py-3 text-foreground-muted">
            No skills, servers, or files in this profile.
          </AppText>
        )}
        {entries.map((entry) => (
          <SettingsRow
            key={entry.keys[0]}
            icon="trash"
            label={entry.label}
            onPress={() => remove(entry.label, entry.keys)}
          />
        ))}
      </SettingsSection>
      {profile.status.conflicts.map((c) => (
        <SettingsSection key={c.key} title={entryKeyLabel(c.key)}>
          <SettingsRow
            icon="iphone"
            label="Keep this device’s value"
            value={entryValueText(c.mine, c.key)}
            onPress={() =>
              profile.sync.profileEngine.resolveConflict(c.key, "keep-mine")
            }
          />
          <SettingsRow
            icon="cloud"
            label="Use synced value"
            value={entryValueText(c.theirs, c.key)}
            onPress={() =>
              profile.sync.profileEngine.resolveConflict(c.key, "take-theirs")
            }
          />
        </SettingsSection>
      ))}
      <SettingsSection title="Environment for skills and servers">
        {profile.connectedHosts.length === 0 && (
          <SettingsRow
            icon="desktopcomputer"
            label="Connect an environment"
            target="SettingsEnvironments"
          />
        )}
        {profile.connectedHosts.map((h) => (
          <SettingsRow
            key={h.hostId}
            icon={
              h.hostId === profile.toolHost?.hostId
                ? "checkmark"
                : "desktopcomputer"
            }
            label={h.label}
            value={h.address ?? undefined}
            onPress={() => profile.chooseToolHost(h.hostId)}
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Add a skill">
        <AppTextInput
          accessibilityLabel="Skill search"
          placeholder="Search skills"
          className="mx-4 my-3 min-h-10 rounded-xl px-3 py-2"
          value={query}
          onChangeText={setQuery}
        />
        <SettingsRow
          icon="magnifyingglass"
          label={searching ? "Searching…" : "Search skills"}
          disabled={!profile.toolHost || !query.trim() || searching}
          onPress={() => void findSkills()}
        />
        {results?.length === 0 && (
          <AppText className="px-4 py-3 text-foreground-muted">
            No matching skills.
          </AppText>
        )}
        {results?.map((skill) => (
          <SettingsRow
            key={skill.id}
            icon="plus"
            label={skill.name}
            value={skill.repo}
            disabled={profile.parts.registrySkills.some(
              (s) => s.name === skill.name,
            )}
            onPress={() => {
              if (profile.addSkill(skill) === "invalid")
                Alert.alert("Could not add skill", skill.name);
            }}
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Add an MCP server">
        <AppTextInput
          accessibilityLabel="Server address"
          placeholder="https://"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={address}
          onChangeText={setAddress}
          className="mx-4 my-3 min-h-10 rounded-xl px-3 py-2"
        />
        <SettingsRow
          label={checking ? "Checking address…" : "Check and add server"}
          icon="plus"
          disabled={!profile.toolHost || !address.trim() || checking}
          onPress={async () => {
            setChecking(true);
            try {
              const error = await profile.addServer(address);
              if (error) Alert.alert("Could not add server", error);
              else setAddress("");
            } finally {
              setChecking(false);
            }
          }}
        />
      </SettingsSection>
      <SettingsSection title="Instructions by model">
        {modelInstructionChoices(profile.modelInstructions).map((m) => (
          <SettingsRow
            key={m.model}
            icon={modelId === m.model ? "checkmark" : "circle"}
            label={m.label}
            value={m.providerLabel}
            onPress={() => setModelId(m.model)}
          />
        ))}
      </SettingsSection>
      {modelId !== "" && (
        <TextSetting
          key={modelId}
          label="Model instructions"
          value={profile.modelInstructions[modelId] ?? ""}
          save={(text) => {
            if (profile.saveModelInstructions(modelId, text) === "invalid")
              throw new Error("Instructions exceed the allowed length.");
          }}
        />
      )}
      {profile.hosts.map((h) => (
        <SettingsSection key={h.hostId} title={h.label}>
          <AppText className="px-4 py-3 text-foreground-muted">
            {hostProfileText(h.state.status, h.state.error, (ms) =>
              new Date(ms).toLocaleString(),
            )}
          </AppText>
          <SettingsRow
            icon="arrow.clockwise"
            label="Pull profile from account"
            disabled={
              !h.connected ||
              h.state.busy ||
              profile.status.state === "signed-out"
            }
            onPress={() => void profile.sync.pull(h.hostId)}
          />
        </SettingsSection>
      ))}
    </SettingsPage>
  );
}
