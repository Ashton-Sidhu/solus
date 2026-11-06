<script lang="ts">
  import { MODEL_PROFILES, REASONING_EFFORT_LABELS } from "@solus/contracts/types";
  import { instanceModelCatalog, changeModelPreference, modelNeighbor } from "@solus/contracts/provider-instance-models";
  import { providerDefaultModel } from "@solus/contracts/provider-model-settings";
  import { AUTO_MODEL_ID } from "@solus/contracts/model-routing";
  import type { ProviderInstance } from "@solus/contracts/provider-instances";
  import { ArrowDown, ArrowUp, ChevronRight, Ellipsis, Eye, EyeOff, Star } from "@lucide/svelte";
  import { getSettingsContext, getWorkspaceContext } from "../../contexts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  let { instance = $bindable() }: { instance: ProviderInstance } = $props();
  const settings = getSettingsContext();
  const workspace = getWorkspaceContext();
  let query = $state("");
  let adding = $state(false);
  let modelId = $state("");
  let modelLabel = $state("");
  let copyFrom = $state("");
  let error = $state("");
  const catalog = $derived(instanceModelCatalog(instance, true));
  const order = $derived(catalog.models.map((model) => model.id));
  const shown = $derived(catalog.models.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(query.toLowerCase())));
  // The same two groups as the model picker: current models, then legacy models behind a disclosure.
  const isLegacy = (id: string) => catalog.modelProfiles[id]?.isLegacy === true;
  const current = $derived(shown.filter((model) => !isLegacy(model.id)));
  const legacy = $derived(shown.filter((model) => isLegacy(model.id)));
  // The model new sessions start with: the personal provider default, else the built-in one.
  const defaultModelId = $derived(providerDefaultModel(instance.provider, settings.defaultModels[instance.provider], catalog.modelProfiles));
  let legacyOpen = $state(false);
  /** The personal default saves at once, as in the default model menu. A hidden model returns to the picker with it. */
  function makeDefault(id: string) {
    if (instance.hiddenModels.includes(id)) instance = changeModelPreference(instance, id, "visibility");
    workspace.config.setDefaultModel(instance.provider, id);
  }
  function moveGroup(id: string) {
    if (!isLegacy(id)) legacyOpen = true;
    instance = changeModelPreference(instance, id, "group");
  }
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

{#snippet defaultButton(id: string, label: string)}
  {@const isDefault = id === defaultModelId}
  {@const action = isDefault ? settings.defaultModels[instance.provider] ? "Use built-in default" : `${label} is the built-in default` : `Make ${label} default`}
  <Button
    variant="ghost"
    size="icon-sm"
    class="shrink-0 pointer-coarse:size-11 {isDefault ? 'text-foreground' : 'text-muted-foreground'}"
    title={action}
    aria-label={action}
    aria-pressed={isDefault}
    disabled={isDefault && !settings.defaultModels[instance.provider]}
    onclick={() => {
      if (!isDefault) makeDefault(id);
      else workspace.config.setDefaultModel(instance.provider, "");
    }}
  >
    <Star size={16} class="size-4" fill={isDefault ? "currentColor" : "none"} />
  </Button>
{/snippet}

{#snippet modelRow(model: { id: string; label: string })}
  {@const custom = instance.customModels.find((item) => item.id === model.id)}
  {@const hidden = !custom && instance.hiddenModels.includes(model.id)}
  <div class="py-3">
    <div class="flex min-w-0 items-center gap-1">
      <div class="min-w-0 flex-1">
        <span class="flex min-w-0 items-center gap-2 text-sm {hidden ? 'text-muted-foreground' : 'text-foreground'}">
          <span class="truncate">{model.label}</span>
          {#if custom}<span class="shrink-0 rounded-full border border-border px-1.5 text-xs text-muted-foreground">Custom</span>{/if}
          {#if hidden}<span class="shrink-0 rounded-full border border-border px-1.5 text-xs text-muted-foreground">Hidden</span>{/if}
        </span>
        <span class="block truncate text-sm text-muted-foreground">{model.id}</span>
      </div>
      {#if !isLegacy(model.id)}
        {@render defaultButton(model.id, model.label)}
      {:else}
        <span class="size-7 shrink-0 pointer-coarse:size-11" aria-hidden="true"></span>
      {/if}
      <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:size-11" title="Move up" aria-label="Move {model.label} up" disabled={modelNeighbor(catalog.modelProfiles, order, model.id, "up") < 0} onclick={() => (instance = changeModelPreference(instance, model.id, "up"))}><ArrowUp size={16} /></Button>
      <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:size-11" title="Move down" aria-label="Move {model.label} down" disabled={modelNeighbor(catalog.modelProfiles, order, model.id, "down") < 0} onclick={() => (instance = changeModelPreference(instance, model.id, "down"))}><ArrowDown size={16} /></Button>
      {#if !custom}
        <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:size-11" disabled={model.id === defaultModelId && !hidden} title={model.id === defaultModelId && !hidden ? "The default model stays in the model picker" : hidden ? "Show in model picker" : "Hide from model picker"} aria-label="{hidden ? 'Show' : 'Hide'} {model.label} {hidden ? 'in' : 'from'} the model picker" aria-pressed={hidden} onclick={() => (instance = changeModelPreference(instance, model.id, "visibility"))}>{#if hidden}<EyeOff size={16} />{:else}<Eye size={16} />{/if}</Button>
      {:else}
        <!-- A custom model is always in the picker; the gap keeps every row's menu in one column. -->
        <span class="size-7 shrink-0 pointer-coarse:size-11" aria-hidden="true"></span>
      {/if}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:size-11" title="More actions" aria-label="More actions for {model.label}"><Ellipsis size={16} /></Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-52">
          <DropdownMenu.Item onSelect={() => moveGroup(model.id)}>{isLegacy(model.id) ? "Move to main models" : "Move to legacy models"}</DropdownMenu.Item>
          {#if custom}
            <DropdownMenu.Item variant="destructive" onSelect={() => instance.customModels.splice(instance.customModels.indexOf(custom), 1)}>Remove custom model</DropdownMenu.Item>
          {/if}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
    {#if custom}
      <div class="mt-3 grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] items-end gap-3">
        <label class="flex flex-col gap-1.5 text-sm text-muted-foreground">Display name<Input aria-label="{model.id} display name" bind:value={custom.label} /></label>
        <label class="flex flex-col gap-1.5 text-sm text-muted-foreground">Default reasoning<SettingsSelect options={custom.reasoningLevels.map((value) => ({ value, label: REASONING_EFFORT_LABELS[value] }))} value={custom.defaultReasoningEffort} onSelect={(value) => (custom.defaultReasoningEffort = value)} ariaLabel="{model.label} default reasoning" /></label>
        <label class="flex flex-col gap-1.5 text-sm text-muted-foreground">Context window (tokens)<Input type="number" aria-label="{model.label} context window" min={1} value={custom.defaultContextWindow} onchange={(event) => { const value = Number(event.currentTarget.value); custom.defaultContextWindow = value; custom.contextWindows = [value]; }} /></label>
        {#if instance.provider === "codex"}<label class="flex h-8 items-center gap-2 text-sm text-muted-foreground"><Switch bind:checked={custom.supportsFastMode} aria-label="{model.label} supports fast mode" />Fast mode</label>{/if}
      </div>
    {/if}
  </div>
{/snippet}

<SettingsSection label="Models" description="Choose the models in the model picker, their order, and which ones sit under Legacy models. Add a custom model ID for a gateway, proxy, or cloud model that is not in the list.">
  <div class="flex flex-col gap-4 p-4">
    <div class="flex items-center gap-2">
      <Input aria-label="Filter provider models" placeholder="Filter models" bind:value={query} class="min-w-0 flex-1" />
      <Button variant="ghost" size="sm" class="shrink-0" onclick={toggleAll}>{instance.hiddenModels.length ? "Show all" : "Hide all"}</Button>
      <Button variant="outline" size="sm" class="shrink-0" disabled={adding} onclick={() => (adding = true)}>Add custom model</Button>
    </div>
    {#if adding}
      <form class="flex flex-col gap-3 rounded-lg border border-border p-4" onsubmit={(event) => { event.preventDefault(); add(); }} onkeydown={(event) => { if (event.key === "Escape") closeForm(); }}>
        <div class="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
          <label class="flex flex-col gap-1.5 text-sm text-muted-foreground">Model ID<!-- svelte-ignore a11y_autofocus --><Input autofocus aria-label="Custom model ID" placeholder="Exact ID the provider accepts" bind:value={modelId} autocomplete="off" spellcheck={false} /></label>
          <label class="flex flex-col gap-1.5 text-sm text-muted-foreground">Display name<Input aria-label="Custom model display name" placeholder="Same as model ID" bind:value={modelLabel} /></label>
          <label class="flex flex-col gap-1.5 text-sm text-muted-foreground">Copy options from
            <SettingsSelect options={[{ value: "", label: "Standard options" }, ...Object.entries(MODEL_PROFILES[instance.provider] ?? {}).filter(([, profile]) => !profile.isLegacy).map(([value, profile]) => ({ value, label: profile.label }))]} value={copyFrom} onSelect={(value) => (copyFrom = value)} ariaLabel="Copy reasoning levels and context window from" />
          </label>
        </div>
        {#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
        <div class="flex justify-end gap-2"><Button variant="ghost" size="sm" onclick={closeForm}>Cancel</Button><Button size="sm" type="submit">Add model</Button></div>
      </form>
    {/if}
    <div class="divide-y divide-border">
      {#if "auto".includes(query.trim().toLowerCase())}
        <!-- Auto is not a model: it picks one from the first prompt, so it can only be the default. -->
        <div class="flex min-w-0 items-center gap-1 py-3">
          <div class="min-w-0 flex-1">
            <span class="flex min-w-0 items-center gap-2 text-sm text-foreground"><span class="truncate">Auto</span></span>
            <span class="block truncate text-sm text-muted-foreground">Picks a model from the first prompt. Configure it in Sessions.</span>
          </div>
          {@render defaultButton(AUTO_MODEL_ID, "Auto")}
          <span class="w-31 shrink-0 pointer-coarse:w-47" aria-hidden="true"></span>
        </div>
      {/if}
      {#each current as model (model.id)}{@render modelRow(model)}{/each}
    </div>
    {#if legacy.length}
      <div class="flex flex-col">
        <button type="button" aria-expanded={legacyOpen || !!query} disabled={!!query} onclick={() => (legacyOpen = !legacyOpen)} class="flex min-w-0 items-center gap-2 overflow-hidden rounded-md py-1 text-left text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <ChevronRight size={16} class="shrink-0 transition-transform duration-150 motion-reduce:transition-none {legacyOpen || query ? 'rotate-90' : ''}" />
          <span class="truncate">Legacy models</span><span class="shrink-0">{legacy.length}</span>
        </button>
        {#if legacyOpen || query}
          <div class="divide-y divide-border">
            {#each legacy as model (model.id)}{@render modelRow(model)}{/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</SettingsSection>
