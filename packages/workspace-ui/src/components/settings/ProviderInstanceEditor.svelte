<script lang="ts">
  import { instanceModelCatalog } from "@solus/contracts/provider-instance-models";
  import ProviderInstanceModels from "./ProviderInstanceModels.svelte";
  import { untrack } from "svelte";
  import type { ProviderInstance } from "@solus/contracts/provider-instances";
  import type { ProviderInstancesClient } from "@solus/client-core/provider-instances";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import ProviderModelSettings from "./ProviderModelSettings.svelte";
  import { launchLock } from "@solus/client-core/policy";
  import { launchLockNotes } from "./policy/lib/launch-lock-notes";
  import { workPolicy } from "../../contexts/policy/work-policy.svelte";

  let { serverId, instance, revision, client, saving }: { serverId: string; instance: ProviderInstance; revision: number; client: ProviderInstancesClient; saving: boolean } = $props();
  // The launch fields the policy of the window's organization's work owns (plans/030 §6.4).
  const launch = $derived(launchLockNotes(launchLock(workPolicy(serverId), instance.provider)));
  let draft = $state(untrack(() => structuredClone(instance)));
  let expectedRevision = $state(untrack(() => revision));
  async function save() {
    const snapshot = await client.write({ expectedRevision, change: { kind: "save", instance: $state.snapshot(draft) } });
    if (!snapshot) return;
    const next = snapshot.instances.find((item) => item.id === draft.id);
    if (next) draft = structuredClone(next);
    expectedRevision = snapshot.revision;
    toasts.success("Provider settings saved", { description: "New turns use these settings. Running turns keep their settings." });
  }
  const isDirty = $derived(JSON.stringify(draft) !== JSON.stringify(instance));
  function discard() { draft = structuredClone(instance); expectedRevision = revision; }
  function addVariable() { draft.environment.push({ name: "", value: "", sensitive: true }); }
</script>

<SettingsSection label="Instance">
  <SettingsRow label="Display name">
    {#snippet control()}<Input aria-label="Provider display name" bind:value={draft.displayName} maxlength={120} />{/snippet}
  </SettingsRow>
  <SettingsRow label="Enabled" description="A disabled instance refuses new turns. Running turns can finish.">
    {#snippet control()}<Switch checked={draft.enabled} onCheckedChange={(value) => (draft.enabled = value)} aria-label="Enable provider instance" />{/snippet}
  </SettingsRow>
</SettingsSection>
<ProviderInstanceModels bind:instance={draft} />
<ProviderModelSettings modelProfiles={instanceModelCatalog(instance).modelProfiles} provider={draft.provider} label="Default model options" description="Options for your default model in new sessions, across projects and hosts. Choose the default model in the list above. Changes save at once." />
<SettingsSection label="Runtime">
  <SettingsRow label="Binary path" description="Executable name or absolute path on this host. Leave empty to use the installed CLI." managed={launch.binaryPath}>
    {#snippet control()}<Input aria-label="Provider binary path" bind:value={draft.binaryPath} placeholder={draft.provider === "codex" ? "codex" : "claude"} />{/snippet}
  </SettingsRow>
  <SettingsRow label={draft.provider === "codex" ? "CODEX_HOME path" : "CLAUDE_CONFIG_DIR path"} description="Custom provider home and config directory on this host. Leave empty to use your seat." managed={launch.homePaths}>
    {#snippet control()}<Input aria-label="Provider home path" bind:value={draft.homePath} placeholder={draft.provider === "codex" ? "~/.codex" : "~/.claude"} />{/snippet}
  </SettingsRow>
  {#if draft.provider === "codex"}
    <SettingsRow label="Shadow home path" description="Separate auth.json while sharing configuration, sessions, and skills from CODEX_HOME." managed={launch.homePaths}>
      {#snippet control()}<Input aria-label="Codex shadow home path" bind:value={draft.shadowHomePath} placeholder="~/.codex-solus/work" />{/snippet}
    </SettingsRow>
  {:else}
    <SettingsRow label="Idle compaction" description="Ask before compacting an old session when you return, or keep the full history.">
      {#snippet control()}<SettingsSelect value={draft.idleCompaction} options={[{ value: "default", label: "Use default" }, { value: "onReturn", label: "Ask on return" }, { value: "off", label: "Never" }]} onSelect={(value) => (draft.idleCompaction = value)} ariaLabel="Claude idle compaction" />{/snippet}
    </SettingsRow>
    <SettingsRow label="Auto-compact after" description="Compact after 100,000 to 1,000,000 tokens. Leave empty for Claude's default.">
      {#snippet control()}<Input type="number" aria-label="Claude auto-compaction token threshold" min={100000} max={1000000} value={draft.autoCompactWindow ?? ""} onchange={(event) => (draft.autoCompactWindow = event.currentTarget.value ? Number(event.currentTarget.value) : null)} />{/snippet}
    </SettingsRow>
  {/if}
  <SettingsRow label="Launch arguments" description="One literal CLI argument per row. Arguments are passed directly, without a shell." managed={launch.launchArgs}>
    {#snippet control()}<Button variant="outline" size="sm" onclick={() => draft.launchArgs.push("")}>Add argument</Button>{/snippet}
    {#snippet body()}
      <div class="space-y-2">
        {#each draft.launchArgs as argument, index (index)}
          <div class="flex min-w-0 gap-2"><Input aria-label="Launch argument {index + 1}" value={argument} oninput={(event) => (draft.launchArgs[index] = event.currentTarget.value)} /><Button variant="ghost" size="sm" onclick={() => draft.launchArgs.splice(index, 1)} aria-label="Remove argument {index + 1}">Remove</Button></div>
        {/each}
      </div>
    {/snippet}
  </SettingsRow>
</SettingsSection>
<SettingsSection label="Environment">
  <SettingsRow label="Variables" description="Private CLI settings, API keys, and base URLs. Saved sensitive values are never returned to clients." managed={launch.environment}>
    {#snippet control()}<Button variant="outline" size="sm" onclick={addVariable}>Add variable</Button>{/snippet}
    {#snippet body()}
      <div class="space-y-3">
        {#each draft.environment as variable, index (index)}
          <div class="flex min-w-0 flex-wrap items-center gap-2" inert={launch.pinnedVariables.includes(variable.name)}>
            <Input class="w-44" aria-label="Environment variable name {index + 1}" bind:value={variable.name} placeholder="VARIABLE_NAME" />
            <Input class="min-w-0 flex-1" type={variable.sensitive ? "password" : "text"} aria-label="Environment variable value {index + 1}" value={variable.value} oninput={(event) => { variable.value = event.currentTarget.value; variable.configured = false; }} placeholder={variable.configured ? "Saved value — leave empty to keep" : "Value"} autocomplete="off" />
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" checked={variable.sensitive} onchange={(event) => { variable.sensitive = event.currentTarget.checked; if (!variable.sensitive) variable.configured = false; }} />Sensitive</label>
            <Button variant="ghost" size="sm" onclick={() => draft.environment.splice(index, 1)} aria-label="Remove environment variable {index + 1}">Remove</Button>
          </div>
        {/each}
      </div>
    {/snippet}
  </SettingsRow>
</SettingsSection>
{#if isDirty || revision !== expectedRevision}
<div class="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 rounded-xl border border-border/50 bg-background/95 px-4 py-3 shadow-sm">
  <p role="status" class="min-w-0 flex-1 text-sm text-muted-foreground">
    {#if revision !== expectedRevision}<span class="text-warning">Settings changed on another client. Your draft is kept. Reload before saving.</span>{:else}You have unsaved changes to this provider.{/if}
  </p>
  {#if revision !== expectedRevision}
    <Button variant="outline" size="sm" onclick={discard}>Reload settings</Button>
  {:else}
    <Button variant="ghost" size="sm" onclick={discard}>Discard</Button>
    <Button size="sm" disabled={saving} onclick={() => void save()}>Save changes</Button>
  {/if}
</div>
{/if}
