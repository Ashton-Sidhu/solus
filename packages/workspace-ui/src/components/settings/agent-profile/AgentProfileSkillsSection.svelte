<script lang="ts">
  /**
   * Settings → Agent profile → Skills: registry skills (a reference the host
   * installs with the skills CLI) and hand-written skills (their files, by
   * name). Adding searches skills.sh through a host this client talks to.
   * A skill can be removed, or turned off on every host and kept in the
   * profile; a hand-written skill's files turn off and on together.
   */
  import { onDestroy, tick } from "svelte";
  import { ExternalLink, LoaderCircle, Plus } from "@lucide/svelte";
  import { agentProfileKeyOf, type AgentProfileKey } from "@solus/contracts/agent-profile";
  import type { RemoteSkill } from "@solus/contracts/types";
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { agentProfileLocalStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import { SearchField } from "../../ui/search-field";
  import SettingsSection from "../SettingsSection.svelte";
  import SettingsRow from "../SettingsRow.svelte";
  import { SkillSearch } from "../skills.store.svelte";
  import { entriesWithDisabled, providerLabel, skillEntryOf, type AgentProfileSections } from "./lib/agent-profile-entries";

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

  function setDisabled(keys: AgentProfileKey[], disabled: boolean) {
    agentProfileLocalStore.setEntry(...entriesWithDisabled(agentProfileLocalStore.storedEntries, keys, disabled));
    requestInputFocus();
  }
</script>

{#if isAdding}
  <SettingsSection label="Add from skills.sh" description="A reference the hosts install for you; the files stay in the registry.">
    {#snippet action()}
      <Button variant="ghost" size="sm" class="[@media(pointer:coarse)]:min-h-11" onclick={closeAdd}>Done</Button>
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
        <SettingsRow label={skill.name} description={skill.repo} testId="agent-profile-skill-result">
          {#snippet labelExtra()}
            <a href={skill.url} onclick={(event) => { event.preventDefault(); localApi.openExternal(skill.url); }}
              class="ml-1.5 inline-flex align-middle text-muted-foreground hover:text-foreground" aria-label="Open {skill.name} on skills.sh">
              <ExternalLink size={14} />
            </a>
          {/snippet}
          {#snippet control()}
            {#if inProfile.has(skill.name)}
              <span class="text-workspace-chrome text-(--solus-accent)">In your profile</span>
            {:else}
              <Button variant="outline" size="sm" class="[@media(pointer:coarse)]:min-h-11" onclick={() => add(skill)}><Plus size={14} />Add</Button>
            {/if}
          {/snippet}
        </SettingsRow>
      {/each}
    {/if}
  </SettingsSection>
{:else}
  <SettingsSection label={skillCount > 0 ? `Skills · ${skillCount}` : "Skills"} description="Installed for you on every host the profile reaches.">
    {#snippet action()}
      <Button variant="outline" size="sm" class="[@media(pointer:coarse)]:min-h-11" onclick={() => void openAdd()}><Plus size={14} />Add from skills.sh</Button>
    {/snippet}
    {#if skillCount === 0}
      <p class="p-8 text-center text-workspace-chrome text-muted-foreground">No skills in your profile yet.</p>
    {/if}
    {#each registrySkills as skill (skill.name)}
      <SettingsRow label={skill.name} description="From skills.sh · {skill.source}" testId="agent-profile-registry-skill">
        {#snippet labelExtra()}
          {#if skill.disabled}<span class="ml-2 text-chrome-dense text-muted-foreground">Off on every host</span>{/if}
        {/snippet}
        {#snippet control()}
          <span class="flex gap-1.5">
            <Button variant="ghost" size="sm" onclick={() => setDisabled([agentProfileKeyOf(skill)], !skill.disabled)} aria-label="{skill.disabled ? 'Enable' : 'Disable'} {skill.name}">{skill.disabled ? "Enable" : "Disable"}</Button>
            <Button variant="ghost" size="sm" class="text-muted-foreground hover:text-destructive" onclick={() => remove(agentProfileKeyOf(skill))} aria-label="Remove {skill.name}">Remove</Button>
          </span>
        {/snippet}
      </SettingsRow>
    {/each}
    {#each writtenSkills as skill (skill.name)}
      <SettingsRow
        label={skill.name}
        description="Hand-written · {skill.fileCount} {skill.fileCount === 1 ? 'file' : 'files'} · {skill.providers.map(providerLabel).join(', ')}"
        testId="agent-profile-written-skill"
      >
        {#snippet labelExtra()}
          {#if skill.disabled}<span class="ml-2 text-chrome-dense text-muted-foreground">Off on every host</span>{/if}
        {/snippet}
        {#snippet control()}
          <span class="flex gap-1.5">
            <Button variant="ghost" size="sm" onclick={() => setDisabled(skill.keys, !skill.disabled)} aria-label="{skill.disabled ? 'Enable' : 'Disable'} {skill.name}">{skill.disabled ? "Enable" : "Disable"}</Button>
            <Button variant="ghost" size="sm" class="text-muted-foreground hover:text-destructive" onclick={() => remove(...skill.keys)} aria-label="Remove {skill.name}">Remove</Button>
          </span>
        {/snippet}
      </SettingsRow>
    {/each}
  </SettingsSection>
{/if}
