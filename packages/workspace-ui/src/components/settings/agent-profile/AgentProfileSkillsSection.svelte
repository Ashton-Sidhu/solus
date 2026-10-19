<script lang="ts">
  /**
   * Settings → Agent profile → Skills: registry skills (a reference the host
   * installs with the skills CLI) and hand-written skills (their files, by
   * name). Adding searches skills.sh through a host this client talks to.
   * Removing a skill takes it off every host; a hand-written skill's files
   * go together. A long list shows a page, then "Show more".
   */
  import { onDestroy, tick } from "svelte";
  import { ExternalLink, LoaderCircle, Package, PenLine, Plus, Trash2 } from "@lucide/svelte";
  import { agentProfileKeyOf, type AgentProfileKey } from "@solus/contracts/agent-profile";
  import type { RemoteSkill } from "@solus/contracts/types";
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { agentProfileLocalStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import { SearchField } from "../../ui/search-field";
  import SettingsSection from "../SettingsSection.svelte";
  import { SkillSearch } from "../skills.store.svelte";
  import ProfileEntryRow from "./ProfileEntryRow.svelte";
  import ShowMoreRow from "./ShowMoreRow.svelte";
  import { pageOf, providerLabel, skillEntryOf, type AgentProfileSections } from "./lib/agent-profile-entries";

  interface Props {
    registrySkills: AgentProfileSections["registrySkills"];
    writtenSkills: AgentProfileSections["writtenSkills"];
    /** The host that searches skills.sh for this client; null with no host connected. */
    searchHostId: string | null;
  }

  let { registrySkills, writtenSkills, searchHostId }: Props = $props();

  const search = new SkillSearch();
  let isAdding = $state(false);
  let query = $state("");
  let searchEl = $state<HTMLInputElement | null>(null);
  let debounce: ReturnType<typeof setTimeout> | null = null;
  // A hand-written skill counts too: a host refuses a registry skill and a hand-written one of the same name.
  const inProfile = $derived(new Set([...registrySkills, ...writtenSkills].map((skill) => skill.name)));
  const skillCount = $derived(registrySkills.length + writtenSkills.length);
  let expanded = $state(false);
  // One list: registry skills first, then hand-written, paged together.
  const page = $derived(pageOf([...registrySkills.map((skill) => ({ kind: "registry" as const, skill })), ...writtenSkills.map((skill) => ({ kind: "written" as const, skill }))], expanded));

  onDestroy(() => {
    if (debounce) clearTimeout(debounce);
    search.cancel();
  });

  function setQuery(value: string) {
    query = value;
    if (debounce) clearTimeout(debounce);
    search.cancel();
    const hostId = searchHostId;
    if (!hostId) return;
    debounce = setTimeout(() => void search.search(serverConnections.apiFor(hostId), value), 350);
  }

  async function openAdd() {
    isAdding = true;
    await tick();
    searchEl?.focus();
  }

  function closeAdd() {
    isAdding = false;
    setQuery("");
    requestInputFocus();
  }

  function add(skill: RemoteSkill) {
    const entry = skillEntryOf(skill);
    if (entry) agentProfileLocalStore.setEntry(entry);
    searchEl?.focus();
  }

  function remove(...keys: AgentProfileKey[]) {
    agentProfileLocalStore.removeKey(...keys);
    requestInputFocus();
  }

  function toggleExpanded() {
    expanded = !expanded;
    requestInputFocus();
  }
</script>

{#snippet tile(kind: "registry" | "written")}
  <span class="grid size-8 shrink-0 place-items-center rounded-lg border border-border/50 bg-muted text-(--solus-text-secondary)" aria-hidden="true">
    {#if kind === "registry"}<Package size={15} />{:else}<PenLine size={15} />{/if}
  </span>
{/snippet}

{#snippet removeButton(name: string, keys: AgentProfileKey[])}
  <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive pointer-coarse:size-11" onclick={() => remove(...keys)} aria-label="Remove {name}" title="Remove">
    <Trash2 size={14} />
  </Button>
{/snippet}

{#if isAdding}
  <SettingsSection label="Add from skills.sh" description="A reference the hosts install for you; the files stay in the registry.">
    {#snippet action()}
      <Button variant="ghost" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={closeAdd}>Done</Button>
    {/snippet}
    <div class="flex items-center">
      <SearchField bind:ref={searchEl} bind:value={() => query, setQuery} placeholder="Search skills.sh…"
        class="min-h-11 rounded-none border-0 px-4 py-2.5 text-workspace-chrome focus-within:border-0 [&_input]:text-workspace-chrome"
        onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeAdd(); } }} />
    </div>
    {#if !searchHostId}
      <p class="p-8 text-center text-workspace-chrome text-muted-foreground">Connect a host to search skills.sh.</p>
    {:else if !query.trim()}
      <p class="p-8 text-center text-workspace-chrome text-muted-foreground">Type to search the skills.sh registry.</p>
    {:else if search.error}
      <div class="flex flex-wrap items-center justify-between gap-3 p-4">
        <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{search.error}</p>
        <Button variant="outline" size="sm" class="[@media(pointer:coarse)]:min-h-11" onclick={() => setQuery(query)}>Retry</Button>
      </div>
    {:else if search.searching || !search.hasSearched}
      <p class="flex items-center justify-center gap-2 p-8 text-workspace-chrome text-muted-foreground" role="status"><LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Searching skills.sh…</p>
    {:else if search.results.length === 0}
      <p class="p-8 text-center text-workspace-chrome text-muted-foreground">No skills found for “{query.trim()}”.</p>
    {:else}
      {#each search.results as skill (skill.id)}
        <ProfileEntryRow label={skill.name} detail={skill.repo} testId="agent-profile-skill-result">
          {#snippet mark()}{@render tile("registry")}{/snippet}
          {#snippet action()}
            <Button variant="ghost" size="icon-sm" class="text-muted-foreground pointer-coarse:size-11" onclick={() => localApi.openExternal(skill.url)} aria-label="Open {skill.name} on skills.sh" title="Open on skills.sh">
              <ExternalLink size={14} />
            </Button>
            {#if inProfile.has(skill.name)}
              <span class="flex h-7 items-center rounded-[min(var(--radius-md),12px)] bg-muted px-2.5 text-workspace-chrome text-foreground pointer-coarse:min-h-11">Added</span>
            {:else}
              <Button variant="outline" size="sm" class="text-workspace-chrome shadow-xs pointer-coarse:min-h-11" onclick={() => add(skill)} aria-label="Add {skill.name}"><Plus size={14} />Add</Button>
            {/if}
          {/snippet}
        </ProfileEntryRow>
      {/each}
    {/if}
  </SettingsSection>
{:else}
  <SettingsSection label={skillCount > 0 ? `Skills · ${skillCount}` : "Skills"} description="Installed for you on every host the profile reaches.">
    {#snippet action()}
      <Button variant="outline" size="sm" class="text-workspace-chrome shadow-xs pointer-coarse:min-h-11" onclick={() => void openAdd()}><Plus size={14} />Add from skills.sh</Button>
    {/snippet}
    {#if skillCount === 0}
      <div class="flex flex-col items-center gap-1 p-8 text-center">
        <p class="text-workspace-chrome text-foreground">No skills in your profile yet</p>
        <p class="text-chrome-dense text-muted-foreground">Add one from skills.sh. It is installed on every host you work on.</p>
      </div>
    {/if}
    {#each page.rows as row (row.skill.name)}
      {#if row.kind === "registry"}
        {@const skill = row.skill}
        <ProfileEntryRow label={skill.name} detail="skills.sh · {skill.source}" testId="agent-profile-registry-skill">
          {#snippet mark()}{@render tile("registry")}{/snippet}
          {#snippet action()}{@render removeButton(skill.name, [agentProfileKeyOf(skill)])}{/snippet}
        </ProfileEntryRow>
      {:else}
        {@const skill = row.skill}
        <ProfileEntryRow
          label={skill.name}
          detail="Hand-written · {skill.fileCount} {skill.fileCount === 1 ? 'file' : 'files'} · {skill.providers.map(providerLabel).join(', ')}"
          testId="agent-profile-written-skill"
        >
          {#snippet mark()}{@render tile("written")}{/snippet}
          {#snippet action()}{@render removeButton(skill.name, skill.keys)}{/snippet}
        </ProfileEntryRow>
      {/if}
    {/each}
    <ShowMoreRow hiddenCount={page.hiddenCount} {expanded} noun="skills" onToggle={toggleExpanded} />
  </SettingsSection>
{/if}
