<script lang="ts">
  import { untrack } from "svelte";
  import { newProviderInstance, type InstanceProvider } from "@solus/contracts/provider-instances";
  import { providerInstancesStore } from "./provider-instances.store.svelte";
  import ProviderInstancesAdvanced from "./ProviderInstancesAdvanced.svelte";
  import ProviderInstanceAccount from "./ProviderInstanceAccount.svelte";
  import ProviderInstanceEditor from "./ProviderInstanceEditor.svelte";
  import ProviderLogo from "../servers/ProviderLogo.svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { SlidersHorizontal } from "@lucide/svelte";
  import SettingsSelect from "./SettingsSelect.svelte";

  let { serverId }: { serverId: string } = $props();
  const client = $derived(providerInstancesStore.client(serverId));
  const view = $derived(providerInstancesStore.view(serverId));
  let selectedId = $state<string | null>(null);
  let adding = $state(false);
  let provider = $state<InstanceProvider>("codex");
  let displayName = $state("");
  const statusInterval = $derived(view.snapshot?.healthCheckSeconds ?? 0);
  let showShared = $state(false);
  // Until the person picks a tab, show the default Claude instance, then any instance.
  const selected = $derived(
    view.snapshot?.instances.find((instance) => instance.id === selectedId)
      ?? view.snapshot?.instances.find((instance) => instance.id === view.snapshot?.selected["claude-code"])
      ?? view.snapshot?.instances[0],
  );
  $effect(() => {
    const hostId = serverId;
    return untrack(() => providerInstancesStore.watch(hostId));
  });
  $effect(() => {
    const id = showShared ? undefined : selected?.id;
    const seconds = statusInterval;
    if (id) return untrack(() => client.watchStatus(id, seconds));
  });
  async function add() {
    const snapshot = view.snapshot;
    if (!snapshot || !displayName.trim()) return;
    const instance = newProviderInstance(provider, crypto.randomUUID(), displayName.trim());
    const saved = await client.write({ expectedRevision: snapshot.revision, change: { kind: "save", instance } });
    if (saved) { selectedId = instance.id; showShared = false; adding = false; displayName = ""; }
  }
  async function remove() {
    if (!selected || !view.snapshot) return;
    const saved = await client.write({ expectedRevision: view.snapshot.revision, change: { kind: "remove", instanceId: selected.id } });
    if (saved) selectedId = null;
  }
</script>

<div class="flex flex-col gap-4">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="text-sm text-muted-foreground">Your private provider instances on this host. Each instance has its own login, runtime, and models.</p>
    <div class="flex items-center gap-2"><Button variant="ghost" size="sm" onclick={() => void client.load()} disabled={view.saving || view.loading}>Refresh</Button><Button variant="outline" size="sm" onclick={() => (adding = !adding)} disabled={!view.snapshot || view.saving}>{adding ? "Cancel" : "Add provider"}</Button></div>
  </div>
  {#if view.error}<p role="alert" class="text-sm text-destructive">{view.error}</p>{/if}
  {#if view.loading}<p role="status" class="text-sm text-muted-foreground">Loading your provider instances…</p>{/if}
  {#if adding}
    <form class="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4" onsubmit={(event) => { event.preventDefault(); void add(); }}>
      <SettingsSelect options={[{ value: "codex", label: "Codex" }, { value: "claude-code", label: "Claude Code" }]} value={provider} onSelect={(value) => (provider = value)} ariaLabel="New provider type" />
      <Input aria-label="New provider display name" placeholder="Display name" bind:value={displayName} maxlength={120} class="min-w-0 flex-1" />
      <Button type="submit" size="sm" disabled={view.saving || !displayName.trim()}>Add</Button>
    </form>
  {/if}
  {#if view.snapshot}
    <!-- One tab per instance: the underlined tab names whose settings sit below it. -->
    <div class="flex items-end gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--border)]" aria-label="Provider instances">
      {#each view.snapshot.instances as instance (instance.id)}
        <button type="button" aria-current={!showShared && selected?.id === instance.id ? "page" : undefined} onclick={() => { selectedId = instance.id; showShared = false; }}
          class="flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-workspace-chrome whitespace-nowrap focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring {!showShared && selected?.id === instance.id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}">
          <ProviderLogo provider={instance.provider === "codex" ? "codex" : "claude"} />
          {instance.displayName}
          {#if view.snapshot.selected[instance.provider] === instance.id && view.snapshot.instances.filter((item) => item.provider === instance.provider).length > 1}<span class="rounded-full border border-border px-1.5 text-xs text-muted-foreground">Default</span>{/if}
          {#if !instance.enabled}<span class="rounded-full border border-border px-1.5 text-xs text-muted-foreground">Off</span>{/if}
        </button>
      {/each}
      <span class="mx-1 mb-3 h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
      <button type="button" aria-current={showShared ? "page" : undefined} onclick={() => (showShared = true)}
        class="flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-workspace-chrome whitespace-nowrap focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring {showShared ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}">
        <SlidersHorizontal size={16} /> Shared settings
      </button>
    </div>
    {#if showShared}
      <p class="text-sm text-muted-foreground">These settings apply to every provider instance on this host.</p>
      <ProviderInstancesAdvanced snapshot={view.snapshot} {client} saving={view.saving} />
    {:else if selected}
      {@const canSelect = view.snapshot.selected[selected.provider] !== selected.id}
      {@const canRemove = selected.id !== "codex" && selected.id !== "claude-code"}
      {#if canSelect || canRemove}
        <div class="flex justify-end gap-2">
          {#if canSelect}<Button variant="outline" size="sm" disabled={view.saving || !selected.enabled} onclick={() => void client.write({ expectedRevision: view.snapshot!.revision, change: { kind: "select", instanceId: selected!.id } })}>Use for new sessions</Button>{/if}
          {#if canRemove}<Button variant="ghost" size="sm" disabled={view.saving} onclick={() => void remove()}>Remove instance</Button>{/if}
        </div>
      {/if}
      <ProviderInstanceAccount instanceId={selected.id} {client} {view} />
      {#key `${serverId}:${selected.id}`}
        <ProviderInstanceEditor {serverId} instance={selected} revision={view.snapshot.revision} {client} saving={view.saving} />
      {/key}
    {/if}
  {/if}
</div>
