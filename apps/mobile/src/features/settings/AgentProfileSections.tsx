import { useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, TextInput, View } from "react-native";

import { agentProfileKeyOf, type AgentProfileFileEntry, type AgentProfileIntegrationEntry, type AgentProfileSkillEntry } from "@solus/contracts/agent-profile";
import type { SeatProvider } from "@solus/contracts/seats";
import type { RemoteSkill } from "@solus/contracts/types";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { AddProjectTextInput } from "../projects/components/add-project-ui";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsSection } from "./components/SettingsSection";
import { urlHost } from "./integrations";
import {
  AUTH_LABELS,
  fileEntryText,
  hostProfileText,
  INSTRUCTION_FILES,
  instructionKey,
  isInstructionFile,
  PROVIDER_LABELS,
  SEAT_PROVIDERS,
  skillFileCountText,
  type HandWrittenSkill,
} from "./lib/agent-profile-entries";
import type { AgentProfileHostRow, useAgentProfile } from "./use-agent-profile";

type AgentProfileModel = ReturnType<typeof useAgentProfile>;

export const formatTime = (epochMs: number) => new Date(epochMs).toLocaleString();

/**
 * The parts of the agent profile screen (plans/020-agent-profile.md §3): the
 * instruction files, the skills, the MCP servers, and the hosts. Each add and
 * remove goes through `useAgentProfile`; the sync controls stay on the screen.
 */

// ─── Instructions ───

export function InstructionsSection({ profile }: { readonly profile: AgentProfileModel }) {
  const otherFiles = profile.parts.files.filter((entry) => !isInstructionFile(entry));
  return (
    <View className="gap-3">
      <SettingsSection title="Instructions">
        {SEAT_PROVIDERS.map((provider, index) => {
          const entry = profile.parts.files.find((candidate) => candidate.provider === provider && isInstructionFile(candidate)) ?? null;
          return (
            <InstructionEditor
              key={`${provider}:${entry?.hash ?? "none"}`}
              provider={provider}
              entry={entry}
              first={index === 0}
              onSave={(text) => profile.saveInstruction(provider, text)}
              onRemove={() => confirmRemove(`Remove ${INSTRUCTION_FILES[provider]}?`, () => profile.removeKeys([instructionKey(provider)]))}
            />
          );
        })}
        {otherFiles.map((entry) => (
          <FileRow key={agentProfileKeyOf(entry)} entry={entry} onRemove={() => confirmRemove(`Remove ${entry.path}?`, () => profile.removeKeys([agentProfileKeyOf(entry)]))} />
        ))}
      </SettingsSection>
      <SettingsNote>What each agent reads first on every host: CLAUDE.md for Claude Code, AGENTS.md for Codex. Subagents, commands, and prompts copied from a computer are listed with them.</SettingsNote>
    </View>
  );
}

function InstructionEditor(props: {
  readonly provider: SeatProvider;
  readonly entry: AgentProfileFileEntry | null;
  readonly first: boolean;
  readonly onSave: (text: string) => "saved" | "invalid";
  readonly onRemove: () => void;
}) {
  const stored = props.entry ? fileEntryText(props.entry) : "";
  const [draft, setDraft] = useState(stored);
  const [failed, setFailed] = useState(false);
  const changed = draft !== stored;
  const label = `${INSTRUCTION_FILES[props.provider]} · ${PROVIDER_LABELS[props.provider]}`;
  return (
    <View className={cn("gap-3 p-4", !props.first && "border-t border-border-subtle")}>
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-lg text-foreground android:text-base" numberOfLines={1}>{label}</Text>
        {changed ? (
          <PillButton label="Save" accessibilityLabel={`Save ${label}`} onPress={() => setFailed(props.onSave(draft) !== "saved")} />
        ) : props.entry ? (
          <PillButton label="Remove" accessibilityLabel={`Remove ${label}`} onPress={props.onRemove} />
        ) : null}
      </View>
      <TextInput
        accessibilityLabel={label}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        value={draft}
        onChangeText={(value) => { setDraft(value); setFailed(false); }}
        placeholder={`Instructions for ${PROVIDER_LABELS[props.provider]}`}
        placeholderTextColorClassName="accent-placeholder"
        selectionColorClassName="accent-focus/32"
        cursorColorClassName="accent-focus"
        className="min-h-24 rounded-2xl border border-border bg-input px-3.5 py-3 font-mono text-sm text-foreground"
      />
      {failed ? <Text className="text-sm text-danger-foreground" accessibilityRole="alert">This file could not be saved: it is over the size limit.</Text> : null}
    </View>
  );
}

function FileRow(props: { readonly entry: AgentProfileFileEntry; readonly onRemove: () => void }) {
  return (
    <View className="flex-row items-center gap-3 border-t border-border-subtle p-4">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-lg text-foreground android:text-base" numberOfLines={1} ellipsizeMode="middle">{props.entry.path}</Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>{PROVIDER_LABELS[props.entry.provider]}</Text>
      </View>
      <PillButton label="Remove" accessibilityLabel={`Remove ${props.entry.path}`} onPress={props.onRemove} />
    </View>
  );
}

// ─── Skills ───

export function SkillsSection({ profile }: { readonly profile: AgentProfileModel }) {
  const { registrySkills, handWrittenSkills } = profile.parts;
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ kind: "idle" } | { kind: "searching" } | { kind: "results"; skills: RemoteSkill[] } | { kind: "failed"; message: string }>({ kind: "idle" });
  const canSearch = profile.toolHost !== null;

  const runSearch = async () => {
    const text = query.trim();
    if (!text) return setSearch({ kind: "idle" });
    setSearch({ kind: "searching" });
    try {
      setSearch({ kind: "results", skills: await profile.searchSkills(text) });
    } catch (cause) {
      setSearch({ kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const added = new Set(registrySkills.map((skill) => skill.name));
  const rows = registrySkills.length + handWrittenSkills.length;
  return (
    <View className="gap-3">
      <SettingsSection title="Skills">
        {rows === 0 ? (
          <View className="p-4">
            <SettingsNote>No skills yet. Search skills.sh below to add one.</SettingsNote>
          </View>
        ) : null}
        {registrySkills.map((skill, index) => (
          <RegistrySkillRow key={skill.name} skill={skill} first={index === 0} onRemove={() => confirmRemove(`Remove ${skill.name}?`, () => profile.removeKeys([`skill:${skill.name}`]))} />
        ))}
        {handWrittenSkills.map((skill, index) => (
          <HandWrittenSkillRow key={`${skill.provider}/${skill.name}`} skill={skill} first={index === 0 && registrySkills.length === 0} onRemove={() => confirmRemove(`Remove ${skill.name}?`, () => profile.removeKeys(skill.keys))} />
        ))}
      </SettingsSection>
      <ToolHostPicker profile={profile} />
      <AddProjectTextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Add from skills.sh"
        accessibilityLabel="Search skills.sh"
        editable={canSearch}
        keyboardType={Platform.OS === "ios" ? "web-search" : "default"}
        returnKeyType="search"
        onSubmitEditing={() => void runSearch()}
      />
      {!canSearch ? (
        <SettingsNote>Connect a host to search skills.sh.</SettingsNote>
      ) : search.kind === "searching" ? (
        <View className="items-center py-2">
          <ActivityIndicator accessibilityLabel="Searching skills.sh" colorClassName="accent-icon-muted" />
        </View>
      ) : search.kind === "failed" ? (
        <SettingsNote tone="danger">{`skills.sh could not be searched: ${search.message}`}</SettingsNote>
      ) : search.kind === "results" ? (
        search.skills.length === 0 ? (
          <SettingsNote>No skill matches.</SettingsNote>
        ) : (
          <SettingsSection title="skills.sh">
            {search.skills.map((skill, index) => (
              <RemoteSkillRow key={skill.id} skill={skill} first={index === 0} added={added.has(skill.name)} onAdd={() => { if (profile.addSkill(skill) !== "saved") Alert.alert("Not added", `${skill.name} is not a name a host accepts, or a hand-written skill already has it.`); }} />
            ))}
          </SettingsSection>
        )
      ) : null}
    </View>
  );
}

function RegistrySkillRow(props: { readonly skill: AgentProfileSkillEntry; readonly first: boolean; readonly onRemove: () => void }) {
  return (
    <View className={cn("flex-row items-center gap-3 p-4", !props.first && "border-t border-border-subtle")}>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-lg text-foreground android:text-base" numberOfLines={1}>{props.skill.name}</Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">{`skills.sh · ${props.skill.source}`}</Text>
      </View>
      <PillButton label="Remove" accessibilityLabel={`Remove ${props.skill.name}`} onPress={props.onRemove} />
    </View>
  );
}

function HandWrittenSkillRow(props: { readonly skill: HandWrittenSkill; readonly first: boolean; readonly onRemove: () => void }) {
  return (
    <View className={cn("flex-row items-center gap-3 p-4", !props.first && "border-t border-border-subtle")}>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-lg text-foreground android:text-base" numberOfLines={1}>{props.skill.name}</Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>{`Hand-written · ${PROVIDER_LABELS[props.skill.provider]} · ${skillFileCountText(props.skill.keys.length)}`}</Text>
      </View>
      <PillButton label="Remove" accessibilityLabel={`Remove ${props.skill.name}`} onPress={props.onRemove} />
    </View>
  );
}

function RemoteSkillRow(props: { readonly skill: RemoteSkill; readonly first: boolean; readonly added: boolean; readonly onAdd: () => void }) {
  const detail = [props.skill.repo, props.skill.installs ? `${props.skill.installs} installs` : null].filter(Boolean).join(" · ");
  return (
    <View className={cn("flex-row items-center gap-3 p-4", !props.first && "border-t border-border-subtle")}>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-lg text-foreground android:text-base" numberOfLines={1}>{props.skill.name}</Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">{detail}</Text>
      </View>
      {props.added ? <Text className="text-sm text-foreground-muted">Added</Text> : <PillButton label="Add" accessibilityLabel={`Add ${props.skill.name}`} onPress={props.onAdd} />}
    </View>
  );
}

// ─── MCP servers ───

export function ServersSection({ profile }: { readonly profile: AgentProfileModel }) {
  const { integrations } = profile.parts;
  const [address, setAddress] = useState("");
  const [adding, setAdding] = useState<{ kind: "idle" } | { kind: "checking" } | { kind: "failed"; message: string }>({ kind: "idle" });
  const canAdd = profile.toolHost !== null && address.trim().length > 0 && adding.kind !== "checking";

  const add = async () => {
    setAdding({ kind: "checking" });
    const failure = await profile.addServer(address);
    if (failure) return setAdding({ kind: "failed", message: failure });
    setAddress("");
    setAdding({ kind: "idle" });
  };

  return (
    <View className="gap-3">
      <SettingsSection title="MCP servers">
        {integrations.length === 0 ? (
          <View className="p-4">
            <SettingsNote>No MCP servers yet. Add one by its address below.</SettingsNote>
          </View>
        ) : (
          integrations.map((integration, index) => (
            <ServerRow key={integration.slug} integration={integration} first={index === 0} onRemove={() => confirmRemove(`Remove ${integration.name}?`, () => profile.removeKeys([`integration:${integration.slug}`]))} />
          ))
        )}
      </SettingsSection>
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1">
          <AddProjectTextInput
            value={address}
            onChangeText={(value) => { setAddress(value); if (adding.kind === "failed") setAdding({ kind: "idle" }); }}
            placeholder="Add a server: https://…"
            accessibilityLabel="MCP server address"
            keyboardType="url"
            returnKeyType="done"
            editable={profile.toolHost !== null}
            onSubmitEditing={() => { if (canAdd) void add(); }}
          />
        </View>
        {adding.kind === "checking" ? (
          <ActivityIndicator accessibilityLabel="Checking the server" colorClassName="accent-icon-muted" />
        ) : (
          <PillButton label="Add" accessibilityLabel="Add the MCP server" disabled={!canAdd} onPress={() => void add()} />
        )}
      </View>
      {profile.toolHost === null ? (
        <SettingsNote>Connect a host to check a server address.</SettingsNote>
      ) : adding.kind === "failed" ? (
        <SettingsNote tone="danger">{adding.message}</SettingsNote>
      ) : (
        <SettingsNote>The record only: its name, address, and how it signs in. Each host connects you with your account’s credential, never a key copied here.</SettingsNote>
      )}
    </View>
  );
}

function ServerRow(props: { readonly integration: AgentProfileIntegrationEntry; readonly first: boolean; readonly onRemove: () => void }) {
  return (
    <View className={cn("flex-row items-center gap-3 p-4", !props.first && "border-t border-border-subtle")}>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-lg text-foreground android:text-base" numberOfLines={1}>{props.integration.name}</Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">{`${urlHost(props.integration.url)} · ${AUTH_LABELS[props.integration.auth.kind]}`}</Text>
      </View>
      <PillButton label="Remove" accessibilityLabel={`Remove ${props.integration.name}`} onPress={props.onRemove} />
    </View>
  );
}

// ─── Hosts ───

export function HostsSection({ profile }: { readonly profile: AgentProfileModel }) {
  if (profile.hosts.length === 0) return null;
  return (
    <View className="gap-3">
      <SettingsSection title="Hosts">
        {profile.hosts.map((host, index) => (
          <HostRow key={host.hostId} host={host} first={index === 0} onPull={() => void profile.sync.pull(host.hostId)} onRemove={() => confirmRemove(`Remove your profile from ${host.label}?`, () => void profile.sync.remove(host.hostId), "Your instructions, skills, and MCP servers copied there are removed. Nothing the host had of its own is touched.")} />
        ))}
      </SettingsSection>
      <SettingsNote>Each host reads your profile from your account when sync is on, and after a change here is sent. Pull now asks it to read again.</SettingsNote>
    </View>
  );
}

function HostRow(props: { readonly host: AgentProfileHostRow; readonly first: boolean; readonly onPull: () => void; readonly onRemove: () => void }) {
  const { host } = props;
  const { state } = host;
  const detail = host.connected ? hostProfileText(state.status, state.error, formatTime) : "Not connected.";
  return (
    <View className={cn("gap-3 p-4", !props.first && "border-t border-border-subtle")}>
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-lg text-foreground android:text-base" numberOfLines={1}>{host.label}</Text>
          <Text className={cn("text-sm", state.error ? "text-danger-foreground" : "text-foreground-muted")} numberOfLines={3}>{detail}</Text>
        </View>
        {state.busy ? <ActivityIndicator accessibilityLabel={`Working on ${host.label}`} colorClassName="accent-icon-muted" /> : null}
      </View>
      <View className="flex-row gap-2">
        <PillButton label="Pull now" accessibilityLabel={`Pull your profile on ${host.label}`} disabled={!host.connected || state.busy} onPress={props.onPull} />
        {state.status?.syncedAt ? (
          <PillButton label="Remove" accessibilityLabel={`Remove your profile from ${host.label}`} disabled={!host.connected || state.busy} onPress={props.onRemove} />
        ) : null}
      </View>
    </View>
  );
}

/** Which connected host searches skills.sh and checks a server address; shown only when there is a choice. */
function ToolHostPicker({ profile }: { readonly profile: AgentProfileModel }) {
  if (profile.connectedHosts.length < 2 || !profile.toolHost) return null;
  return (
    <SettingsSection title="Search and check through">
      {profile.connectedHosts.map((host, index) => (
        <SettingsChoiceRow
          key={host.hostId}
          separated={index > 0}
          label={host.label}
          selected={host.hostId === profile.toolHost?.hostId}
          onPress={() => profile.chooseToolHost(host.hostId)}
        />
      ))}
    </SettingsSection>
  );
}

// ─── Shared ───

function confirmRemove(title: string, remove: () => void, message = "It leaves this device and, when sync is on, your account and every host."): void {
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: "Remove", style: "destructive", onPress: remove },
  ]);
}

function PillButton(props: { readonly label: string; readonly accessibilityLabel?: string; readonly disabled?: boolean; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn("self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70", props.disabled && "opacity-40")}
    >
      <Text className="text-xs font-t3-bold text-foreground">{props.label}</Text>
    </Pressable>
  );
}
