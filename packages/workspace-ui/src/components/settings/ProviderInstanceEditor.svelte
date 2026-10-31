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

  let { instance, revision, client, saving }: { instance: ProviderInstance; revision: number; client: ProviderInstancesClient; saving: boolean } = $props();
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
  <SettingsRow label="Accent color">
    {#snippet control()}
      <div class="flex items-center gap-2">
        {#if draft.accentColor}<Button variant="ghost" size="sm" onclick={() => (draft.accentColor = null)}>Reset</Button>{:else}<span class="text-sm text-muted-foreground">None</span>{/if}
        <label class="relative size-6 shrink-0 cursor-pointer rounded-full has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring {draft.accentColor ? 'ring-1 ring-black/10 ring-inset dark:ring-white/15' : 'border border-dashed border-muted-foreground/50'}" style:background-color={draft.accentColor}>
          <input type="color" aria-label="Provider accent color" value={draft.accentColor ?? "#808080"} oninput={(event) => (draft.accentColor = event.currentTarget.value)} class="absolute inset-0 size-full cursor-pointer opacity-0" />
        </label>
      </div>
    {/snippet}
  </SettingsRow>
  <SettingsRow label="Enabled" description="A disabled instance refuses new turns. Running turns can finish.">
    {#snippet control()}<Switch checked={draft.enabled} onCheckedChange={(value) => (draft.enabled = value)} aria-label="Enable provider instance" />{/snippet}
  </SettingsRow>
</SettingsSection>
<SettingsSection label="Runtime">
  <SettingsRow label="Binary path" description="Executable name or absolute path on this host. Leave empty to use the installed CLI.">
    {#snippet control()}<Input aria-label="Provider binary path" bind:value={draft.binaryPath} placeholder={draft.provider === "codex" ? "codex" : "claude"} />{/snippet}
  </SettingsRow>
  <SettingsRow label={draft.provider === "codex" ? "CODEX_HOME path" : "CLAUDE_CONFIG_DIR path"} description="Custom provider home and config directory on this host. Leave empty to use your seat.">
    {#snippet control()}<Input aria-label="Provider home path" bind:value={draft.homePath} placeholder={draft.provider === "codex" ? "~/.codex" : "~/.claude"} />{/snippet}
  </SettingsRow>
  {#if draft.provider === "codex"}
    <SettingsRow label="Shadow home path" description="Separate auth.json while sharing configuration, sessions, and skills from CODEX_HOME.">
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
  <SettingsRow label="Launch arguments" description="One literal CLI argument per row. Arguments are passed directly, without a shell.">
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
  <SettingsRow label="Variables" description="Private CLI settings, API keys, and base URLs. Saved sensitive values are never returned to clients.">
    {#snippet control()}<Button variant="outline" size="sm" onclick={addVariable}>Add variable</Button>{/snippet}
    {#snippet body()}
      <div class="space-y-3">
        {#each draft.environment as variable, index (index)}
          <div class="flex min-w-0 flex-wrap items-center gap-2">
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
<ProviderInstanceModels bind:instance={draft} />
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
<ProviderModelSettings modelProfiles={instanceModelCatalog(instance).modelProfiles} provider={draft.provider} label="Provider model default" description="Your personal default for this provider across projects and hosts. Changes save at once." />
