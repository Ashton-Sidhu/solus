<script lang="ts">
  import { Plus, Trash2 } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Input } from "../ui/input";
  import { fitPresetToProject, presetsForProject, profileDraft, profilesFromDrafts, type RunProfileDraft } from "@solus/client-core/device-run-profiles";
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
  }

  let { serverId, checkoutPath, onDone }: Props = $props();

  const saved = $derived(devicesStore.runProfiles(serverId, checkoutPath));
  const presets = $derived(presetsForProject(devicesStore.project(serverId, checkoutPath)));
  let drafts = $state<RunProfileDraft[]>([]);
  let loaded = $state(false);
  let saving = $state(false);
  let problem = $state<string | null>(null);
  let adding = $state(false);
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

  // A preset starts in the folder the app is in (a monorepo's `apps/mobile/ios`), with the Xcode workspace there.
  async function add(index: number) {
    const preset = presets[index];
    if (!preset || adding) return;
    adding = true;
    try {
      drafts.push(profileDraft(await fitPresetToProject(serverConnections.apiFor(serverId), checkoutPath, preset.profile)));
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
      onDone();
      requestInputFocus();
    } catch (cause) {
      problem = deviceErrorMessage(cause);
    } finally {
      saving = false;
    }
  }
</script>

<div class="flex flex-col gap-3 text-chrome-dense" data-testid="device-run-profiles">
  <div class="flex flex-col gap-1">
    <h3 class="text-workspace-chrome text-(--solus-text-primary)">Build & run</h3>
    <p class="text-(--solus-text-secondary)">
      Say how this project builds its app. New build and Build & run build it in this checkout.
      Profiles are saved in <code>.solus/config.json</code>.
    </p>
  </div>

  {#if !loaded}
    <p class="text-(--solus-text-tertiary)" role="status">Reading the project's profiles…</p>
  {:else}
    {#each drafts as draft, index (index)}
      <fieldset class="flex flex-col gap-2 rounded-lg p-3 shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)]">
        <div class="flex items-center gap-2">
          <Input class="h-7 flex-1" bind:value={draft.name} placeholder="Name" aria-label="Profile name" />
          <Button size="icon-xs" variant="ghost" aria-label="Remove {draft.name || 'this profile'}" onclick={() => drafts.splice(index, 1)}><Trash2 /></Button>
        </div>
        <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Platform and build kind">
          <Button size="xs" variant={draft.platform === "ios" ? "secondary" : "ghost"} aria-pressed={draft.platform === "ios"} onclick={() => { draft.platform = "ios"; if (draft.target === "any") draft.target = "simulator"; }}>iOS</Button>
          <Button size="xs" variant={draft.platform === "android" ? "secondary" : "ghost"} aria-pressed={draft.platform === "android"} onclick={() => { draft.platform = "android"; draft.target = "any"; }}>Android</Button>
          {#if draft.platform === "ios"}
            <span class="mx-1 h-4 w-px bg-[var(--hairline-strong)]"></span>
            <Button size="xs" variant={draft.target === "simulator" ? "secondary" : "ghost"} aria-pressed={draft.target === "simulator"} onclick={() => (draft.target = "simulator")}>Simulator build</Button>
            <Button size="xs" variant={draft.target === "device" ? "secondary" : "ghost"} aria-pressed={draft.target === "device"} onclick={() => (draft.target = "device")}>iPhone or iPad build</Button>
          {/if}
        </div>
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
      </fieldset>
    {:else}
      <p class="text-(--solus-text-tertiary)">No profiles yet. Start from a common build below and edit the scheme and folders.</p>
    {/each}

    <div class="flex flex-wrap items-center gap-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} size="xs" variant="outline" disabled={adding}><Plus />{adding ? "Adding…" : "Add a profile"}</Button>
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
      <span class="flex-1"></span>
      <Button size="xs" variant="ghost" onclick={onDone}>Cancel</Button>
      <Button size="xs" disabled={saving || !canSave} title={canSave ? undefined : "Add a profile first"} onclick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>
    </div>
    {#if problem}<p class="text-[var(--failure)]" role="alert">{problem}</p>{/if}
  {/if}
</div>
