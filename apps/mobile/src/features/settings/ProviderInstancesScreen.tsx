import { hostPathBaseName } from "@solus/contracts/host-path";
import { ProjectProvidersSection } from "./ProjectProvidersSection";
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ProviderInstancesClient } from "@solus/client-core/provider-instances";
import { newProviderInstance, type InstanceProvider, type ProviderInstance, type ProviderInstancesSnapshot } from "@solus/contracts/provider-instances";
import { useProviderInstances } from "./use-provider-instances";
import { useApp, useListened } from "../../app/app-context";
import { AppText } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { ProviderInstanceModelsSection } from "./ProviderInstanceModelsSection";
import { ProviderInstanceAccountSection } from "./ProviderInstanceAccountSection";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsNote } from "./components/SettingsNote";

export function ProviderInstancesScreen({ route, navigation }: ScreenProps<"ProviderInstances">) {
  const { hostId, instanceId, projectPath } = route.params;
  const app = useApp();
  const hostLabel = useListened(app.registry.changes, () => app.registry.host(hostId)?.label ?? hostId);
  const insets = useSafeAreaInsets();
  const { client, view, readiness } = useProviderInstances(hostId);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<InstanceProvider>("codex");
  const [name, setName] = useState("");
  const instance = view.snapshot?.instances.find((item) => item.id === instanceId);
  useEffect(() => {
    if (instance && !projectPath) return client.watchStatus(instance.id, view.snapshot?.healthCheckSeconds ?? 0);
  }, [client, instance?.id, projectPath, view.snapshot?.healthCheckSeconds]);
  async function add() {
    if (!view.snapshot || !name.trim()) return;
    const next = newProviderInstance(provider, `instance-${Date.now().toString(36)}`, name.trim());
    const saved = await client.write({ expectedRevision: view.snapshot.revision, change: { kind: "save", instance: next } });
    if (saved) { setAdding(false); setName(""); navigation.push("ProviderInstances", { hostId, instanceId: next.id }); }
  }
  return <SettingsScreen title={instance?.displayName ?? "Providers"}>
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-5 pt-4" contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}>
      {!projectPath ? <ProviderInstancesStatus state={{ client, view, readiness }} /> : null}
      <AppText className="pt-3 text-base font-medium text-foreground">
        Applying settings for{" "}
        <AppText accessibilityRole="button" accessibilityLabel="Settings project" className="underline" onPress={() => navigation.navigate("SettingsScope", { hostId, projectPath })}>
          {projectPath ? hostPathBaseName(projectPath) : "All projects"}
        </AppText>
        {" on "}
        <AppText accessibilityRole="button" accessibilityLabel="Settings host" className="underline" onPress={() => navigation.navigate("SettingsScope", { hostId, projectPath, axis: "host" })}>
          {hostLabel}
        </AppText>
      </AppText>
      {projectPath ? <ProjectProvidersSection projectPath={projectPath} state={{ client, view, readiness }} /> : <>
      {instance && view.snapshot ? <><ProviderInstanceAccountSection instanceId={instance.id} client={client} view={view} /><InstanceEditor key={`${hostId}:${instance.id}`} instance={instance} revision={view.snapshot.revision} client={client} saving={view.saving} /></> : !instanceId && view.snapshot ? <>
        <SettingsNote>These instances are private to your Solus user on this host.</SettingsNote>
        <SettingsSection title="Providers">
          {view.snapshot.instances.map((item) => <View key={item.id}>
            <SettingsRow icon="sparkles" label={item.displayName} value={`${item.provider === "codex" ? "Codex" : "Claude Code"}${view.snapshot!.selected[item.provider] === item.id ? " · Default instance" : ""}`} onPress={() => navigation.push("ProviderInstances", { hostId, instanceId: item.id })} />
            <SettingsSwitchRow label={`Enable ${item.displayName}`} value={item.enabled} onValueChange={(enabled) => { void client.write({ expectedRevision: view.snapshot!.revision, change: { kind: "save", instance: { ...item, enabled } } }); }} />
          </View>)}
        </SettingsSection>
        <InstanceAdvanced snapshot={view.snapshot} client={client} saving={view.saving} />
        <SettingsSection title="Manage">
          <SettingsActionRow icon="plus" label={adding ? "Cancel" : "Add provider"} disabled={view.saving} onPress={() => setAdding(!adding)} />
          <SettingsActionRow icon="arrow.clockwise" label="Refresh" disabled={view.saving} onPress={() => { void client.load(); }} />
        </SettingsSection>
        {adding ? <SettingsSection title="New provider">
          <SettingsChoiceRow label="Codex" selected={provider === "codex"} onPress={() => setProvider("codex")} />
          <SettingsChoiceRow separated label="Claude Code" selected={provider === "claude-code"} onPress={() => setProvider("claude-code")} />
          <Field label="Display name" value={name} onChange={setName} />
          <SettingsActionRow icon="plus" label="Add" disabled={view.saving || !name.trim()} onPress={() => { void add(); }} />
        </SettingsSection> : null}
      </> : instanceId && !view.loading ? <SettingsNote>This provider instance is no longer available.</SettingsNote> : null}
      {instance && view.snapshot ? <InstanceActions instance={instance} snapshot={view.snapshot} client={client} saving={view.saving} navigation={navigation} hostId={hostId} /> : null}
      </>}
    </ScreenScrollView>
  </SettingsScreen>;
}

function InstanceEditor({ instance, revision, client, saving }: { instance: ProviderInstance; revision: number; client: ProviderInstancesClient; saving: boolean }) {
  const [draft, setDraft] = useState(() => structuredClone(instance));
  const [expectedRevision, setExpectedRevision] = useState(revision);
  const stale = revision !== expectedRevision;
  const dirty = JSON.stringify(draft) !== JSON.stringify(instance);
  const patch = (value: Partial<ProviderInstance>) => setDraft((current) => ({ ...current, ...value }));
  async function save() {
    const snapshot = await client.write({ expectedRevision, change: { kind: "save", instance: draft } });
    const saved = snapshot?.instances.find((item) => item.id === draft.id);
    if (snapshot && saved) { setDraft(structuredClone(saved)); setExpectedRevision(snapshot.revision); }
  }
  return <>
    {stale ? <SettingsNote>Settings changed on another client. Your draft is kept. Reload before saving.</SettingsNote> : null}
    <SettingsSection title="Instance">
      <Field label="Display name" value={draft.displayName} onChange={(displayName) => patch({ displayName })} />
      <Field label="Accent color" value={draft.accentColor ?? ""} placeholder="#3366ff" onChange={(accentColor) => patch({ accentColor: accentColor || null })} />
      <SettingsSwitchRow label="Enabled" value={draft.enabled} onValueChange={(enabled) => patch({ enabled })} />
    </SettingsSection>
    <SettingsSection title="Runtime">
      <Field label="Binary path" value={draft.binaryPath} placeholder={draft.provider === "codex" ? "codex" : "claude"} onChange={(binaryPath) => patch({ binaryPath })} />
      <Field label={draft.provider === "codex" ? "CODEX_HOME path" : "CLAUDE_CONFIG_DIR path"} value={draft.homePath} placeholder="Use your seat" onChange={(homePath) => patch({ homePath })} />
      {draft.provider === "codex" ? <Field label="Shadow home path" value={draft.shadowHomePath} placeholder="~/.codex-solus/work" onChange={(shadowHomePath) => patch({ shadowHomePath })} /> : <Field label="Auto-compact after (tokens)" value={draft.autoCompactWindow === null ? "" : String(draft.autoCompactWindow)} placeholder="Claude default" onChange={(value) => patch({ autoCompactWindow: value ? Number(value) : null })} />}
      {draft.launchArgs.map((argument, index) => <View key={index}>
        <Field label={`Launch argument ${index + 1}`} value={argument} onChange={(value) => patch({ launchArgs: draft.launchArgs.map((item, at) => at === index ? value : item) })} />
        <SettingsActionRow icon="minus" label={`Remove argument ${index + 1}`} onPress={() => patch({ launchArgs: draft.launchArgs.filter((_, at) => at !== index) })} />
      </View>)}
      <SettingsActionRow icon="plus" label="Add argument" onPress={() => patch({ launchArgs: [...draft.launchArgs, ""] })} />
    </SettingsSection>
    {draft.provider === "claude-code" ? <SettingsSection title="Idle compaction">
      <SettingsChoiceRow label="Use default" selected={draft.idleCompaction === "default"} onPress={() => patch({ idleCompaction: "default" })} />
      <SettingsChoiceRow label="Ask on return" selected={draft.idleCompaction === "onReturn"} onPress={() => patch({ idleCompaction: "onReturn" })} />
      <SettingsChoiceRow label="Never" selected={draft.idleCompaction === "off"} onPress={() => patch({ idleCompaction: "off" })} />
    </SettingsSection> : null}
    <SettingsNote>Each row is one literal argument. No shell is used. Home paths resolve on this host.</SettingsNote>
    <SettingsSection title="Environment">
      {draft.environment.map((variable, index) => <View key={index}>
        <Field label={`Variable name ${index + 1}`} value={variable.name} onChange={(name) => patch({ environment: draft.environment.map((item, at) => at === index ? { ...item, name } : item) })} />
        <Field label={`Variable value ${index + 1}`} value={variable.value} sensitive={variable.sensitive} placeholder={variable.configured ? "Saved value — leave empty to keep" : "Value"} onChange={(value) => patch({ environment: draft.environment.map((item, at) => at === index ? { ...item, value, configured: false } : item) })} />
        <SettingsSwitchRow label="Sensitive" value={variable.sensitive} onValueChange={(sensitive) => patch({ environment: draft.environment.map((item, at) => at === index ? { ...item, sensitive, configured: sensitive && item.configured } : item) })} />
        <SettingsActionRow icon="minus" label={`Remove variable ${index + 1}`} onPress={() => patch({ environment: draft.environment.filter((_, at) => at !== index) })} />
      </View>)}
      <SettingsActionRow icon="plus" label="Add variable" onPress={() => patch({ environment: [...draft.environment, { name: "", value: "", sensitive: true }] })} />
    </SettingsSection>
    <ProviderInstanceModelsSection instance={draft} onChange={setDraft} />
    {dirty || stale ? <SettingsSection title="Unsaved changes">
      {stale ? <SettingsActionRow icon="arrow.clockwise" label="Reload settings" onPress={() => { setDraft(structuredClone(instance)); setExpectedRevision(revision); }} /> : <>
        <SettingsActionRow icon="checkmark" label="Save provider settings" disabled={saving} loading={saving} onPress={() => { void save(); }} />
        <SettingsActionRow icon="xmark" label="Discard changes" disabled={saving} onPress={() => setDraft(structuredClone(instance))} />
      </>}
    </SettingsSection> : null}
    <SettingsNote>Runtime changes apply to new turns. Running turns keep their settings. Sensitive values are not returned to clients.</SettingsNote>
  </>;
}

function Field({ label, value, placeholder, sensitive, onChange }: { label: string; value: string; placeholder?: string; sensitive?: boolean; onChange: (value: string) => void }) {
  return <View className="gap-2 px-4 py-3">
    <AppText className="text-base text-foreground">{label}</AppText>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} placeholder={placeholder} secureTextEntry={sensitive} autoCapitalize="none" autoCorrect={false} className="min-h-10 rounded-lg border border-border bg-input px-3 py-2 text-base text-foreground" />
  </View>;
}

function InstanceActions({ instance, snapshot, client, saving, navigation, hostId }: { hostId: string; instance: ProviderInstance; snapshot: ProviderInstancesSnapshot; client: ProviderInstancesClient; saving: boolean; navigation: ScreenProps<"ProviderInstances">["navigation"] }) {
  return <SettingsSection title="Instance actions">
        {snapshot.selected[instance.provider] !== instance.id ? <SettingsActionRow icon="checkmark" label="Use for new sessions" disabled={saving || !instance.enabled} onPress={() => { void client.write({ expectedRevision: snapshot.revision, change: { kind: "select", instanceId: instance.id } }); }} /> : null}
        <SettingsRow icon="sparkles" label="Provider model default" onPress={() => navigation.navigate("ProviderSettings", { provider: instance.provider, hostId, instanceId: instance.id })} />
        {instance.id !== "codex" && instance.id !== "claude-code" ? <SettingsActionRow icon="trash" label="Remove instance" tone="danger" disabled={saving} onPress={() => { void client.write({ expectedRevision: snapshot.revision, change: { kind: "remove", instanceId: instance.id } }).then((saved) => { if (saved) navigation.goBack(); }); }} /> : null}
      </SettingsSection>;
}

function InstanceAdvanced({ snapshot, client, saving }: { snapshot: ProviderInstancesSnapshot; client: ProviderInstancesClient; saving: boolean }) {
  const [seconds, setSeconds] = useState(String(snapshot.healthCheckSeconds));
  useEffect(() => setSeconds(String(snapshot.healthCheckSeconds)), [snapshot.healthCheckSeconds]);
  function save(healthCheckSeconds: number, idleCompaction = snapshot.idleCompaction) {
    void client.write({ expectedRevision: snapshot.revision, change: { kind: "advanced", healthCheckSeconds, idleCompaction } });
  }
  return <>
    <SettingsSection title="Advanced provider settings">
      <Field label="Status check interval (seconds)" value={seconds} onChange={setSeconds} />
      <SettingsActionRow icon="checkmark" label="Save interval" disabled={saving} onPress={() => save(Number(seconds))} />
      <SettingsActionRow icon="arrow.clockwise" label="Reset interval" disabled={saving} onPress={() => save(300)} />
      <SettingsChoiceRow label="Default idle compaction: Ask on return" selected={snapshot.idleCompaction === "onReturn"} onPress={() => save(snapshot.healthCheckSeconds, "onReturn")} />
      <SettingsChoiceRow label="Default idle compaction: Never" selected={snapshot.idleCompaction === "off"} onPress={() => save(snapshot.healthCheckSeconds, "off")} />
    </SettingsSection>
    <SettingsNote>Status checks run while a provider detail page is open. Set 0 to disable repeated checks. Idle compaction applies to Claude Code.</SettingsNote>
  </>;
}


function ProviderInstancesStatus({ state }: { state: ReturnType<typeof useProviderInstances> }) {
  return <>
    {state.view.error ? <AppText accessibilityRole="alert" className="text-base text-danger-foreground">{state.view.error}</AppText> : null}
    {state.readiness !== "ready" ? <SettingsNote>Connect this host to manage your private provider instances.</SettingsNote> : null}
    {state.view.loading ? <SettingsNote>Loading your provider instances…</SettingsNote> : null}
  </>;
}
