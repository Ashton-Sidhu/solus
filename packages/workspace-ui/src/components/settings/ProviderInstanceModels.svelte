<script lang="ts">
  import { MODEL_PROFILES, REASONING_EFFORT_LABELS } from "@solus/contracts/types";
  import { instanceModelCatalog, changeModelPreference } from "@solus/contracts/provider-instance-models";
  import type { ProviderInstance } from "@solus/contracts/provider-instances";
  import { ArrowDown, ArrowUp, Star, Trash2 } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  let { instance = $bindable() }: { instance: ProviderInstance } = $props();
  let query = $state("");
  let adding = $state(false);
  let modelId = $state("");
  let modelLabel = $state("");
  let copyFrom = $state("");
  let error = $state("");
  const catalog = $derived(instanceModelCatalog(instance, true));
  const order = $derived(catalog.models.map((model) => model.id));
  const shown = $derived(catalog.models.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(query.toLowerCase())));
  function add() {
    if (!modelId.trim()) { error = "Enter the model ID that the provider accepts."; return; }
    if (catalog.modelProfiles[modelId.trim()]) { error = "This model ID is already in the list."; return; }
    const profile = MODEL_PROFILES[instance.provider]?.[copyFrom];
    instance.customModels.push({ id: modelId.trim(), label: modelLabel.trim() || modelId.trim(), reasoningLevels: [...(profile?.reasoningLevels ?? ["low", "medium", "high"])], defaultReasoningEffort: profile?.defaultReasoningEffort ?? "high", contextWindows: [...(profile?.contextWindows ?? [200000])], defaultContextWindow: profile?.defaultContextWindow ?? 200000, supportsFastMode: profile?.supportsFastMode ?? false });
    closeForm();
  }
  function closeForm() { adding = false; modelId = ""; modelLabel = ""; copyFrom = ""; error = ""; }
  function toggleAll() {
    instance.hiddenModels = instance.hiddenModels.length ? [] : Object.keys(MODEL_PROFILES[instance.provider] ?? {});
  }
</script>

<SettingsSection label="Models" description="Choose the models in the model picker and their order. Add a custom model ID for a gateway, proxy, or cloud model that is not in the list.">
  {#snippet action()}{#if !adding}<Button variant="outline" size="sm" onclick={() => (adding = true)}>Add custom model</Button>{/if}{/snippet}
  <div class="flex flex-col gap-4 p-4">
    {#if adding}
      <form class="flex flex-col gap-3 rounded-lg border border-border p-4" onsubmit={(event) => { event.preventDefault(); add(); }} onkeydown={(event) => { if (event.key === "Escape") closeForm(); }}>
        <p class="text-sm font-medium text-foreground">New custom model</p>
        <div class="flex flex-wrap gap-3">
          <label class="flex min-w-48 flex-1 flex-col gap-1.5 text-sm text-muted-foreground">Model ID<!-- svelte-ignore a11y_autofocus --><Input autofocus aria-label="Custom model ID" placeholder="Exact ID the provider accepts" bind:value={modelId} autocomplete="off" spellcheck={false} /></label>
          <label class="flex min-w-48 flex-1 flex-col gap-1.5 text-sm text-muted-foreground">Display name<Input aria-label="Custom model display name" placeholder="Same as model ID" bind:value={modelLabel} /></label>
        </div>
        <label class="flex flex-col gap-1.5 text-sm text-muted-foreground">Copy reasoning levels and context window from
          <SettingsSelect options={[{ value: "", label: "Standard options" }, ...Object.entries(MODEL_PROFILES[instance.provider] ?? {}).filter(([, profile]) => !profile.isLegacy).map(([value, profile]) => ({ value, label: profile.label }))]} value={copyFrom} onSelect={(value) => (copyFrom = value)} ariaLabel="Copy custom model options from" />
        </label>
        {#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
        <div class="flex justify-end gap-2"><Button variant="ghost" size="sm" onclick={closeForm}>Cancel</Button><Button size="sm" type="submit">Add model</Button></div>
      </form>
    {/if}
    <div class="flex items-center gap-2"><Input aria-label="Filter provider models" placeholder="Filter models" bind:value={query} class="min-w-0 flex-1" /><Button variant="ghost" size="sm" class="shrink-0" onclick={toggleAll}>{instance.hiddenModels.length ? "Show all" : "Hide all"}</Button></div>
    <div class="max-h-80 overflow-y-auto divide-y divide-border">
      {#each shown as model (model.id)}
        {@const custom = instance.customModels.find((item) => item.id === model.id)}
        {@const favorite = instance.favoriteModels.includes(model.id)}
        <div class="flex min-w-0 items-center gap-1 py-3">
          <div class="min-w-0 flex-1"><span class="block truncate text-sm text-foreground">{model.label}{#if custom}<span class="ml-2 text-xs text-muted-foreground">Custom</span>{/if}</span><span class="block truncate text-sm text-muted-foreground">{model.id}</span></div>
          <Button variant="ghost" size="icon-sm" class="shrink-0 pointer-coarse:size-11 {favorite ? 'text-primary' : 'text-muted-foreground'}" title={favorite ? "Remove from favorites" : "Add to favorites"} aria-label="{favorite ? 'Remove' : 'Add'} {model.label} {favorite ? 'from' : 'to'} favorites" aria-pressed={favorite} onclick={() => (instance = changeModelPreference(instance, model.id, "favorite"))}><Star size={16} fill={favorite ? "currentColor" : "none"} /></Button>
          <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:size-11" title="Move up" aria-label="Move {model.label} up" disabled={order[0] === model.id} onclick={() => (instance = changeModelPreference(instance, model.id, "up"))}><ArrowUp size={16} /></Button>
          <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:size-11" title="Move down" aria-label="Move {model.label} down" disabled={order.at(-1) === model.id} onclick={() => (instance = changeModelPreference(instance, model.id, "down"))}><ArrowDown size={16} /></Button>
          <div class="ml-2 flex w-9 shrink-0 justify-end">
            {#if custom}<Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive pointer-coarse:size-11" title="Remove custom model" onclick={() => instance.customModels.splice(instance.customModels.indexOf(custom), 1)} aria-label="Remove custom model {model.label}"><Trash2 size={16} /></Button>{:else}<Switch checked={!instance.hiddenModels.includes(model.id)} onCheckedChange={() => (instance = changeModelPreference(instance, model.id, "visibility"))} title="Show in the model picker" aria-label="Show {model.label} in the model picker" />{/if}
          </div>
        </div>
        {#if custom}
          <div class="flex flex-wrap gap-3 pb-4">
            <label class="flex min-w-40 flex-1 flex-col gap-1.5 text-sm text-muted-foreground">Display name<Input aria-label="{model.id} display name" bind:value={custom.label} /></label>
            <label class="flex min-w-40 flex-1 flex-col gap-1.5 text-sm text-muted-foreground">Default reasoning<SettingsSelect options={custom.reasoningLevels.map((value) => ({ value, label: REASONING_EFFORT_LABELS[value] }))} value={custom.defaultReasoningEffort} onSelect={(value) => (custom.defaultReasoningEffort = value)} ariaLabel="{model.label} default reasoning" /></label>
            <label class="flex min-w-40 flex-1 flex-col gap-1.5 text-sm text-muted-foreground">Context window (tokens)<Input type="number" aria-label="{model.label} context window" min={1} value={custom.defaultContextWindow} onchange={(event) => { const value = Number(event.currentTarget.value); custom.defaultContextWindow = value; custom.contextWindows = [value]; }} /></label>
            {#if instance.provider === "codex"}<label class="flex items-center gap-2 self-end pb-2 text-sm text-muted-foreground"><Switch bind:checked={custom.supportsFastMode} aria-label="{model.label} supports fast mode" />Fast mode</label>{/if}
          </div>
        {/if}
      {/each}
    </div>
  </div>
</SettingsSection>
