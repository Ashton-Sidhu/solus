import { useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, TextInput, View } from "react-native";

import { agentProfileKeyOf, type AgentProfileFileEntry, type AgentProfileIntegrationEntry, type AgentProfileSkillEntry } from "@solus/contracts/agent-profile";
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
  hostProfileText,
  pageOf,
  PROVIDER_LABELS,
  skillFileCountText,
  type HandWrittenSkill,
} from "./lib/agent-profile-entries";
import type { AgentProfileHostRow, useAgentProfile, useAgentProfileHosts } from "./use-agent-profile";

type AgentProfileModel = ReturnType<typeof useAgentProfile>;

export const formatTime = (epochMs: number) => new Date(epochMs).toLocaleString();

/**
 * The parts of the agent profile screen (plans/020-agent-profile.md §3): the
 * person's instructions, the skills, the MCP servers, and the copied files;
 * and, on the account's sync screen, the hosts. Each add and remove goes
 * through `useAgentProfile`; removing takes the entry off every host. A long
 * list shows a page, then "Show more".
 */

// ─── Instructions ───

export function InstructionsSection({ profile }: { readonly profile: AgentProfileModel }) {
  return (
    <View className="gap-3">
      <SettingsSection title="Instructions">
        <ExtraInstructionsEditor key={profile.extraInstructions} stored={profile.extraInstructions} onSave={profile.saveExtraInstructions} />
      </SettingsSection>
      <SettingsNote>Your own instructions, sent with every prompt on every host. A project's CLAUDE.md or AGENTS.md stays with the project.</SettingsNote>
    </View>
  );
}

function ExtraInstructionsEditor(props: { readonly stored: string; readonly onSave: (text: string) => "saved" | "invalid" }) {
  const [draft, setDraft] = useState(props.stored);
  const [failed, setFailed] = useState(false);
  const changed = draft !== props.stored;
  return (
    <View className="gap-3 p-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-lg text-foreground android:text-base" numberOfLines={1}>Extra instructions</Text>
        {changed ? <PillButton label="Save" accessibilityLabel="Save your extra instructions" onPress={() => setFailed(props.onSave(draft) !== "saved")} /> : null}
      </View>
      <TextInput
        accessibilityLabel="Extra instructions"
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        value={draft}
        onChangeText={(value) => { setDraft(value); setFailed(false); }}
        placeholder="Prefer concise answers. Use specific libraries. Follow my writing style."
        placeholderTextColorClassName="accent-placeholder"
        selectionColorClassName="accent-focus/32"
        cursorColorClassName="accent-focus"
        className="min-h-24 rounded-2xl border border-border bg-input px-3.5 py-3 font-mono text-sm text-foreground"
      />
      {failed ? <Text className="text-sm text-danger-foreground" accessibilityRole="alert">These instructions could not be saved: they are over the size limit.</Text> : null}
    </View>
  );
}

/** Subagents, commands, and prompts copied from a computer: listed, not edited. Nothing when the profile holds none. */
export function FilesSection({ profile }: { readonly profile: AgentProfileModel }) {
  const [expanded, setExpanded] = useState(false);
  if (profile.parts.files.length === 0) return null;
  const page = pageOf(profile.parts.files, expanded);
  return (
    <View className="gap-3">
      <SettingsSection title="Files">
        {page.rows.map((entry, index) => (
          <FileRow
            key={agentProfileKeyOf(entry)}
            entry={entry}
            first={index === 0}
            onRemove={() => confirmRemove(`Remove ${entry.path}?`, () => profile.removeKeys([agentProfileKeyOf(entry)]))}
          />
        ))}
        <ShowMoreRow hiddenCount={page.hiddenCount} expanded={expanded} noun="files" onToggle={() => setExpanded((value) => !value)} />
      </SettingsSection>
      <SettingsNote>Subagents, commands, and prompts from a computer's home, on every host you work on.</SettingsNote>
    </View>
  );
}

function FileRow(props: { readonly entry: AgentProfileFileEntry; readonly first: boolean; readonly onRemove: () => void }) {
  return (
    <View className={cn("flex-row items-center gap-3 p-4", !props.first && "border-t border-border-subtle")}>
      <View className="min-w-0 flex-1 gap-0.5">
        <EntryTitle middle>{props.entry.path}</EntryTitle>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>{PROVIDER_LABELS[props.entry.provider]}</Text>
      </View>
      <RemoveButton name={props.entry.path} onPress={props.onRemove} />
    </View>
  );
}

// ─── Skills ───

export function SkillsSection({ profile }: { readonly profile: AgentProfileModel }) {
  const [expanded, setExpanded] = useState(false);
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
  // One list: registry skills first, then hand-written, paged together.
  const page = pageOf(
    [...registrySkills.map((skill) => ({ kind: "registry" as const, skill })), ...handWrittenSkills.map((skill) => ({ kind: "written" as const, skill }))],
    expanded,
  );
  return (
    <View className="gap-3">
      <SettingsSection title="Skills">
        {page.rows.length === 0 ? (
          <View className="p-4">
            <SettingsNote>No skills yet. Search skills.sh below to add one.</SettingsNote>
          </View>
        ) : null}
        {page.rows.map((row, index) =>
          row.kind === "registry" ? (
            <RegistrySkillRow
              key={row.skill.name}
              skill={row.skill}
              first={index === 0}
              onRemove={() => confirmRemove(`Remove ${row.skill.name}?`, () => profile.removeKeys([`skill:${row.skill.name}`]))}
            />
          ) : (
            <HandWrittenSkillRow
              key={`${row.skill.provider}/${row.skill.name}`}
              skill={row.skill}
              first={index === 0}
              onRemove={() => confirmRemove(`Remove ${row.skill.name}?`, () => profile.removeKeys(row.skill.keys))}
            />
          ),
        )}
        <ShowMoreRow hiddenCount={page.hiddenCount} expanded={expanded} noun="skills" onToggle={() => setExpanded((value) => !value)} />
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
        <EntryTitle>{props.skill.name}</EntryTitle>
        <Text className="text-sm text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">{`skills.sh · ${props.skill.source}`}</Text>
      </View>
      <RemoveButton name={props.skill.name} onPress={props.onRemove} />
    </View>
  );
}

function HandWrittenSkillRow(props: { readonly skill: HandWrittenSkill; readonly first: boolean; readonly onRemove: () => void }) {
  return (
    <View className={cn("flex-row items-center gap-3 p-4", !props.first && "border-t border-border-subtle")}>
      <View className="min-w-0 flex-1 gap-0.5">
        <EntryTitle>{props.skill.name}</EntryTitle>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>{`Hand-written · ${PROVIDER_LABELS[props.skill.provider]} · ${skillFileCountText(props.skill.keys.length)}`}</Text>
      </View>
      <RemoveButton name={props.skill.name} onPress={props.onRemove} />
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
  const [expanded, setExpanded] = useState(false);
  const page = pageOf(integrations, expanded);
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
          page.rows.map((integration, index) => (
            <ServerRow
              key={integration.slug}
              integration={integration}
              first={index === 0}
              onRemove={() => confirmRemove(`Remove ${integration.name}?`, () => profile.removeKeys([`integration:${integration.slug}`]))}
            />
          ))
        )}
        <ShowMoreRow hiddenCount={page.hiddenCount} expanded={expanded} noun="servers" onToggle={() => setExpanded((value) => !value)} />
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
        <EntryTitle>{props.integration.name}</EntryTitle>
        <Text className="text-sm text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">{`${urlHost(props.integration.url)} · ${AUTH_LABELS[props.integration.auth.kind]}`}</Text>
      </View>
      <RemoveButton name={props.integration.name} onPress={props.onRemove} />
    </View>
  );
}

// ─── Hosts ───

/** On the account's sync screen: each host, what it holds of the profile, with Pull now and Remove. */
export function HostsSection({ hosts, sync }: ReturnType<typeof useAgentProfileHosts>) {
  if (hosts.length === 0) return null;
  return (
    <View className="gap-3">
      <SettingsSection title="Hosts">
        {hosts.map((host, index) => (
          <HostRow key={host.hostId} host={host} first={index === 0} onPull={() => void sync.pull(host.hostId)} onRemove={() => confirmRemove(`Remove your profile from ${host.label}?`, () => void sync.remove(host.hostId), "Your instructions, skills, and MCP servers copied there are removed. Nothing the host had of its own is touched.")} />
        ))}
      </SettingsSection>
      <SettingsNote>Each host reads your agent profile from your account when you are signed in, and after a change is sent. Pull now asks it to read again. A host's own link to your account is on its settings page.</SettingsNote>
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

/** A row's name. */
function EntryTitle(props: { readonly middle?: boolean; readonly children: string }) {
  return (
    <Text className="text-lg text-foreground android:text-base" numberOfLines={1} ellipsizeMode={props.middle ? "middle" : "tail"}>
      {props.children}
    </Text>
  );
}

/** Remove takes the entry out of the profile and off every host. */
function RemoveButton(props: { readonly name: string; readonly onPress: () => void }) {
  return <PillButton label="Remove" accessibilityLabel={`Remove ${props.name}`} onPress={props.onPress} />;
}

/** The last row of a long list: the rows not shown, and the way to show them or fold them again. */
function ShowMoreRow(props: { readonly hiddenCount: number; readonly expanded: boolean; readonly noun: string; readonly onToggle: () => void }) {
  if (props.hiddenCount === 0 && !props.expanded) return null;
  return (
    <View className="items-center border-t border-border-subtle p-3">
      <PillButton label={props.expanded ? `Show fewer ${props.noun}` : `Show ${props.hiddenCount} more`} onPress={props.onToggle} />
    </View>
  );
}

function confirmRemove(title: string, remove: () => void, message = "It leaves this device and, when you are signed in, your account and every host."): void {
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
      hitSlop={{ top: 8, bottom: 8 }}
      className={cn("self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70", props.disabled && "opacity-40")}
    >
      <Text className="text-xs font-t3-bold text-foreground">{props.label}</Text>
    </Pressable>
  );
}
