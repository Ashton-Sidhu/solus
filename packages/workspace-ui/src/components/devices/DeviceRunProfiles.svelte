<script lang="ts">
  import { Check, ChevronRight, Plus, Trash2 } from "@lucide/svelte";
  import { onMount, untrack } from "svelte";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Input } from "../ui/input";
  import { RowCard } from "../ui/row-card";
  import { RUN_PROFILE_PRESETS, commandSigningTeam, draftConfiguration, draftForPreset, fitPresetToProject, needsSigningTeam, presetFor, profileDraft, profilesFromDrafts, profileSummary, signingTeamHint, withConfiguration, withSigningTeam, type BuildConfiguration, type RunProfileDraft, type RunProfilePreset } from "@solus/client-core/device-run-profiles";
  import { serverConnections } from "@solus/client-core/server-connections";

  /**
   * How this project builds its app, for Build & run (plan 016, S02). The
   * profiles are saved in the project's `.solus/config.json`, so they can be
   * committed and shared. Commands run without a shell; the host asks once
   * before it runs a new or changed command.
   */
  interface Props {
    serverId: string;
    checkoutPath: string;
    onDone: () => void;
    /** After a save, in place of onDone. New build uses it to offer the saved profiles. */
    onSaved?: () => void;
  }

  let { serverId, checkoutPath, onDone, onSaved }: Props = $props();
  const projectName = $derived(checkoutPath.split(/[\\/]/).filter(Boolean).at(-1) ?? checkoutPath);

  const saved = $derived(devicesStore.runProfiles(serverId, checkoutPath));
  const presets = RUN_PROFILE_PRESETS;
  const CONFIGURATIONS: BuildConfiguration[] = ["Debug", "Release"];
  const teams = $derived(devicesStore.signingTeams(serverId) ?? []);
  let drafts = $state<RunProfileDraft[]>([]);
  let loaded = $state(false);
  let saving = $state(false);
  let problem = $state<string | null>(null);
  let adding = $state(false);
  /** The profile open for editing. A new one opens; saved ones start closed. */
  let openIndex = $state<number | null>(null);

  /** Saving nothing over nothing would only look like a setup. Removing every saved profile still saves. */
  const canSave = $derived(drafts.length > 0 || (saved?.length ?? 0) > 0);

  // The form starts from what the project saved, once that arrives.
  $effect(() => {
    if (loaded || saved === undefined) return;
    const profiles = saved;
    untrack(() => {
      drafts = (profiles ?? []).map(profileDraft);
      loaded = true;
    });
  });

  onMount(() => void devicesStore.refreshSigningTeams(serverId));

  // A preset starts in the folder the app is in (a monorepo's `apps/mobile/ios`), with the Xcode workspace there.
  async function add(index: number) {
    const preset = presets[index];
    if (!preset || adding) return;
    adding = true;
    try {
      drafts.push(profileDraft(await fitPresetToProject(serverConnections.apiFor(serverId), checkoutPath, preset.profile)));
      openIndex = drafts.length - 1;
    } finally {
      adding = false;
    }
  }

  /** Build for something else: the command, folder and output come from that preset, fitted to the project. */
  async function buildFor(index: number, preset: RunProfilePreset) {
    const draft = drafts[index];
    if (!draft || adding || presetFor(draft) === preset) return;
    adding = true;
    try {
      drafts[index] = await draftForPreset(serverConnections.apiFor(serverId), checkoutPath, draft, preset);
    } finally {
      adding = false;
    }
  }

  async function save() {
    const checked = profilesFromDrafts(drafts);
    if ("error" in checked) {
      problem = checked.error;
      return;
    }
    problem = null;
    saving = true;
    try {
      await devicesStore.saveRunProfiles(serverId, checkoutPath, checked.profiles);
      toasts.success("Build profiles saved to .solus/config.json");
      if (onSaved) {
        onSaved();
      } else {
        onDone();
        requestInputFocus();
      }
    } catch (cause) {
      problem = deviceErrorMessage(cause);
    } finally {
      saving = false;
    }
  }
</script>

<div class="flex flex-col gap-3 text-chrome-dense" data-testid="device-run-profiles">
  <div class="flex flex-col gap-1">
    <h3 class="text-workspace-chrome text-(--solus-text-primary)">How {projectName} builds</h3>
    <p class="text-(--solus-text-secondary)">
      Each profile is one way to build the app. Pick one from New build to build it.
      Saved in <code>.solus/config.json</code>.
    </p>
  </div>

  {#if !loaded}
    <p class="text-(--solus-text-tertiary)" role="status">Reading the project's profiles…</p>
  {:else}
    {#if drafts.length > 0}
      <!-- One row per profile, as Settings draws a list. A row says what the
           profile builds; it opens to edit. The command and paths come from
           the preset and sit under Build details, so they do not crowd the form. -->
      <RowCard>
        {#each drafts as draft, index (index)}
          {@const isOpen = openIndex === index}
          <div class="flex flex-col">
            <div class="flex min-w-0 items-center gap-1 py-1.5 pr-2 pl-1">
              <button type="button" class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-(--solus-surface-hover)" aria-expanded={isOpen} onclick={() => (openIndex = isOpen ? null : index)}>
                <ChevronRight size={14} class="shrink-0 text-(--solus-text-tertiary) transition-transform {isOpen ? 'rotate-90' : ''}" />
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate font-medium text-(--solus-text-primary)">{draft.name || "Unnamed profile"}</span>
                  <span class="truncate text-(--solus-text-tertiary)">{profileSummary(draft, teams)}</span>
                </span>
              </button>
              <Button size="icon-xs" variant="ghost" aria-label="Remove {draft.name || 'this profile'}" onclick={() => { drafts.splice(index, 1); openIndex = null; }}><Trash2 /></Button>
            </div>
            {#if isOpen}
              <div class="flex flex-col gap-3 pr-4 pb-4 pl-10">
                <label class="flex flex-col gap-1">
                  <span class="text-(--solus-text-tertiary)">Name</span>
                  <Input class="h-7" bind:value={draft.name} placeholder="iOS simulator" />
                </label>
                <div class="flex flex-col gap-1">
                  <span class="text-(--solus-text-tertiary)">Builds for</span>
                  <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Builds for">
                    {#each presets as preset (preset.label)}
                      {@const isChosen = presetFor(draft) === preset}
                      <Button size="xs" variant="outline" role="radio" aria-checked={isChosen} disabled={adding} class={isChosen ? "border-(--solus-accent) text-(--solus-text-primary)" : "text-(--solus-text-secondary)"} onclick={() => void buildFor(index, preset)}>
                        {#if isChosen}<Check />{/if}{preset.label}
                      </Button>
                    {/each}
                  </div>
                </div>
                {#if draftConfiguration(draft)}
                  {@const configuration = draftConfiguration(draft)}
                  <div class="flex flex-col gap-1">
                    <span class="text-(--solus-text-tertiary)">Configuration</span>
                    <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Configuration">
                      {#each CONFIGURATIONS as choice (choice)}
                        {@const isChosen = configuration === choice}
                        <Button size="xs" variant="outline" role="radio" aria-checked={isChosen} class={isChosen ? "border-(--solus-accent) text-(--solus-text-primary)" : "text-(--solus-text-secondary)"} onclick={() => Object.assign(draft, withConfiguration(draft, choice))}>
                          {#if isChosen}<Check />{/if}{choice}
                        </Button>
                      {/each}
                    </div>
                    <span class="text-(--solus-text-tertiary)">{configuration === "Debug" ? "For development. An Expo or React Native app loads its JavaScript from Metro." : "The app as people get it, with its JavaScript bundled in."}</span>
                  </div>
                {/if}
                {#if needsSigningTeam(draft)}
                  <!-- The team lives in the command as DEVELOPMENT_TEAM=, so the command stays the one source. -->
                  <div class="flex flex-col gap-1.5">
                    <span class="text-(--solus-text-tertiary)">Signing team</span>
                    {#if teams.length}
                      <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Signing team">
                        {#each teams as team (team.teamId)}
                          {@const isChosen = commandSigningTeam(draft.commandText) === team.teamId}
                          <Button size="xs" variant="outline" role="radio" aria-checked={isChosen} class={isChosen ? "border-(--solus-accent) text-(--solus-text-primary)" : "text-(--solus-text-secondary)"} onclick={() => (draft.commandText = withSigningTeam(draft.commandText, team.teamId))}>
                            {#if isChosen}<Check />{/if}{team.name} · {team.teamId}
                          </Button>
                        {/each}
                      </div>
                    {/if}
                    <Input class="h-7 font-mono" value={commandSigningTeam(draft.commandText)} placeholder={teams.length ? "Or enter a team id" : "Team id, such as A1B2C3D4E5"} aria-label="Signing team id" oninput={(event) => (draft.commandText = withSigningTeam(draft.commandText, event.currentTarget.value))} />
                    <span class="text-(--solus-text-tertiary)">{signingTeamHint(teams)}</span>
                  </div>
                {/if}
                <details class="group flex flex-col">
                  <summary class="flex cursor-pointer list-none items-center gap-1 text-(--solus-text-secondary) hover:text-(--solus-text-primary) [&::-webkit-details-marker]:hidden">
                    <ChevronRight size={14} class="transition-transform group-open:rotate-90" />Build details
                  </summary>
                  <div class="mt-3 flex flex-col gap-3">
                    <label class="flex flex-col gap-1">
                      <span class="text-(--solus-text-tertiary)">Folder, from the checkout root</span>
                      <Input class="h-7 font-mono" bind:value={draft.cwd} placeholder="." />
                    </label>
                    <label class="flex flex-col gap-1">
                      <span class="text-(--solus-text-tertiary)">Command (no shell: pipes and variables are not expanded)</span>
                      <Input class="h-7 font-mono" bind:value={draft.commandText} placeholder="./gradlew assembleDebug" />
                    </label>
                    <label class="flex flex-col gap-1">
                      <span class="text-(--solus-text-tertiary)">Output, from that folder (* matches within one folder name)</span>
                      <Input class="h-7 font-mono" bind:value={draft.artifact} placeholder="app/build/outputs/apk/debug/*.apk" />
                    </label>
                    <label class="flex flex-col gap-1">
                      <span class="text-(--solus-text-tertiary)">App id {draft.platform === "android" ? "(needed to open the app)" : "(optional; read from the app)"}</span>
                      <Input class="h-7 font-mono" bind:value={draft.appId} placeholder="com.example.app" />
                    </label>
                  </div>
                </details>
              </div>
            {/if}
          </div>
        {/each}
      </RowCard>
    {:else}
      <!-- No profile yet: the starting points are the first step, so show them, not a menu. -->
      <div class="flex flex-col gap-2" role="group" aria-label="Start from">
        <span class="text-(--solus-text-tertiary)">What does this project build for? Solus finds the app in the project and fills in the rest.</span>
        <div class="flex flex-wrap items-center gap-1.5">
          {#each presets as preset, index (preset.label)}
            <Button size="xs" variant="outline" disabled={adding} onclick={() => void add(index)}><Plus />{preset.label}</Button>
          {/each}
        </div>
        {#if adding}<span class="text-(--solus-text-tertiary)" role="status">Finding the app in the project…</span>{/if}
      </div>
    {/if}

    <div class="flex flex-wrap items-center gap-2">
      {#if drafts.length > 0}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} size="xs" variant="outline" disabled={adding}><Plus />{adding ? "Adding…" : "Add another profile"}</Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <!-- Sized to its labels, not to the small trigger: the default anchor width wraps every row. -->
        <DropdownMenu.Content align="start" class="w-auto min-w-56 max-w-[calc(100vw-2rem)]">
          <DropdownMenu.Label>Start from</DropdownMenu.Label>
          {#each presets as preset, index (preset.label)}
            <DropdownMenu.Item class="whitespace-nowrap" onSelect={() => void add(index)}>{preset.label}</DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {/if}
      <span class="flex-1"></span>
      <Button size="xs" variant="ghost" onclick={onDone}>Cancel</Button>
      <Button size="xs" disabled={saving || !canSave} title={canSave ? undefined : "Add a profile first"} onclick={() => void save()}>{saving ? "Saving…" : "Save profiles"}</Button>
    </div>
    {#if problem}<p class="text-[var(--failure)]" role="alert">{problem}</p>{/if}
  {/if}
</div>
