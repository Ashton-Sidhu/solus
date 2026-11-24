<script lang="ts">
  /** The form of a new codebase: a name and a first folder. The folder is
   *  scanned on its host before the codebase is made, so the person sees what
   *  it holds. */
  import { ArrowLeft as ArrowLeftIcon } from "@lucide/svelte";
  import { codebasesStore } from "../../contexts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import CodebaseRootPicker from "./CodebaseRootPicker.svelte";
  import { RootPickerState } from "./lib/root-picker.svelte";

  let { onClose, onCreated }: { onClose: () => void; onCreated: (codebaseId: string) => void } = $props();

  let name = $state("");
  let isBusy = $state(false);
  let error = $state("");
  const picker = new RootPickerState(() => []);

  const canCreate = $derived(!isBusy && name.trim() !== "" && picker.choice !== null);

  async function create() {
    const choice = picker.choice;
    if (!canCreate || !choice) return;
    isBusy = true;
    error = "";
    try {
      const created = await codebasesStore.create(name, [choice]);
      onCreated(created.id);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "Could not make the codebase.";
    } finally {
      isBusy = false;
    }
  }
</script>

<div class="flex flex-col gap-8">
  <div class="flex flex-wrap items-center gap-3">
    <Button size="sm" variant="ghost" onclick={onClose}><ArrowLeftIcon size={14} /> Codebases</Button>
    <h2 class="text-lg font-medium">New codebase</h2>
  </div>

  <SettingsSection label="Codebase">
    <SettingsRow label="Name" description="A short name for this set of folders.">
      {#snippet control()}
        <Input bind:value={name} class="h-7 w-56" aria-label="Codebase name" maxlength={200} autofocus disabled={isBusy} onSubmit={() => void create()} />
      {/snippet}
    </SettingsRow>
  </SettingsSection>

  <SettingsSection
    label="First folder"
    description="After you make the codebase, you can add more folders, on this host or on a different one."
    plain
  >
    <div class="rounded-xl border border-border bg-background p-4 dark:bg-card">
      <CodebaseRootPicker {picker} disabled={isBusy} />
    </div>
  </SettingsSection>

  {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}

  <div class="flex items-center gap-2">
    <Button size="sm" disabled={!canCreate} onclick={() => void create()}>{isBusy ? "Making the codebase…" : "Create codebase"}</Button>
    <Button size="sm" variant="ghost" disabled={isBusy} onclick={onClose}>Cancel</Button>
  </div>
</div>
