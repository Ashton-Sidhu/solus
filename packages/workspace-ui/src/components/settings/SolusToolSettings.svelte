<script lang="ts">
  /** Solus tools for agents, one row per tool group. A group's row carries the
   *  switch for the whole group; the per-tool switches sit behind a disclosure
   *  so the sixty-odd tools do not push the rest of the Tools page off screen. */
  import { ChevronRight as CaretRightIcon } from "@lucide/svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { isSolusToolEnabled } from "@solus/contracts/agent-tools";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { solusToolsStore as store } from "./solus-tools.store.svelte";
  import { matchingToolGroups, groupEnabled, groupPatch, groupSummary, toolLabel } from "./lib/solus-tool-groups";

  let { serverId, searchQuery = "" }: { serverId: string; searchQuery?: string } = $props();
  const state = $derived(store.states.get(serverId));
  const hasKey = $derived(!!state?.typeSafe?.source);
  const groups = $derived(matchingToolGroups(searchQuery));
  const locked = $derived(!state?.preferences || state.saving || !!state.error);
  const expanded = new SvelteSet<string>();

  /** A search that names some tools of a group opens that group so the match is visible. */
  function isExpanded(group: (typeof groups)[number]): boolean {
    return expanded.has(group.id) || group.visibleTools.length < group.tools.length;
  }

  function toggle(groupId: string) {
    if (expanded.has(groupId)) expanded.delete(groupId);
    else expanded.add(groupId);
  }

  function describe(group: (typeof groups)[number]): string {
    if (group.id === "intelligence" && !hasKey) return "Add a TypeSafe API key to enable Ask Jev.";
    return groupSummary(group.tools, state?.preferences);
  }
</script>

<SettingsSection
  label="Solus tools"
  description="Tools agents on this host can call. Turning a tool off blocks new calls immediately. Start a new session after turning a tool on so the agent can see it."
  visible={groups.length > 0}
>
  {#snippet action()}
    {#if state?.error}
      <div class="flex items-center gap-2 text-workspace-chrome" role="alert">
        <span class="text-destructive">{state.error}</span>
        <button type="button" class="underline" onclick={() => store.load(serverId)}>Retry</button>
      </div>
    {:else if !state?.preferences}
      <span class="text-workspace-chrome text-muted-foreground" role="status">Loading…</span>
    {/if}
  {/snippet}
  {#each groups as group (group.id)}
    {@const open = isExpanded(group)}
    {@const keyLocked = group.id === "intelligence" && !hasKey}
    <SettingsRow label={group.label} description={describe(group)} bodyVisible={open}>
      {#snippet control()}
        <div class="flex items-center gap-1.5">
          <Switch
            aria-label={`Enable all ${group.label.toLowerCase()} tools`}
            checked={!!state?.preferences && groupEnabled(group.tools, state.preferences) && !keyLocked}
            disabled={locked || keyLocked}
            onCheckedChange={(enabled) => void store.save(serverId, groupPatch(group.tools, enabled))}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={open ? `Hide ${group.label.toLowerCase()} tools` : `Show ${group.label.toLowerCase()} tools`}
            aria-expanded={open}
            aria-controls={`solus-tools-${group.id}`}
            onclick={() => toggle(group.id)}
          >
            <CaretRightIcon size={13} class="transition-transform duration-150 motion-reduce:transition-none {open ? 'rotate-90' : ''}" />
          </Button>
        </div>
      {/snippet}
      {#snippet body()}
        <ul id={`solus-tools-${group.id}`} class="flex flex-col divide-y divide-border rounded-lg border border-border">
          {#each group.visibleTools as name (name)}
            <li class="flex items-center justify-between gap-4 px-3 py-2 [.is-laptop-display_&]:py-1.5">
              <div class="min-w-0">
                <div class="truncate text-workspace-chrome text-(--solus-text-primary)">{toolLabel(name)}</div>
                <code class="block truncate font-[family-name:var(--solus-code-font-family)] text-[0.8125em] text-muted-foreground">{name}</code>
              </div>
              <Switch
                aria-label={toolLabel(name)}
                checked={!!state?.preferences && isSolusToolEnabled(name, state.preferences) && !(name === "ask_jev" && !hasKey)}
                disabled={locked || (name === "ask_jev" && !hasKey)}
                onCheckedChange={(enabled) => void store.save(serverId, { [name]: enabled })}
              />
            </li>
          {/each}
        </ul>
      {/snippet}
    </SettingsRow>
  {/each}
</SettingsSection>
