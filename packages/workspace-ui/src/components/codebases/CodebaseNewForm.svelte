<script lang="ts">
  /** The form of a new codebase: a name and two folders. A codebase has two
   *  or more folders, because one folder is a project. Each folder is scanned
   *  on its host before the codebase is made, so the person sees what it
   *  holds. */
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
  const firstPicker = new RootPickerState(() => []);
  // The second folder is refused when it is the first one, is inside it, or holds it.
  const secondPicker = new RootPickerState(() => firstPicker.chosenRoots);

  const canCreate = $derived(!isBusy && name.trim() !== "" && firstPicker.choice !== null && secondPicker.choice !== null);

  async function create() {
    const first = firstPicker.choice;
    const second = secondPicker.choice;
    if (!canCreate || !first || !second) return;
    isBusy = true;
    error = "";
    try {
      const created = await codebasesStore.create(name, [first, second]);
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
    description="A codebase has two or more folders. One folder is a project: a session there gets the repositories inside it with no codebase."
    plain
  >
    <div class="rounded-xl border border-border bg-background p-4 dark:bg-card">
      <CodebaseRootPicker picker={firstPicker} disabled={isBusy} />
    </div>
  </SettingsSection>

  <SettingsSection
    label="Second folder"
    description="A different folder, on this host or on a different one. After you make the codebase, you can add more folders."
    plain
  >
    <div class="rounded-xl border border-border bg-background p-4 dark:bg-card">
      <CodebaseRootPicker picker={secondPicker} disabled={isBusy} />
    </div>
  </SettingsSection>

  {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}

  <div class="flex items-center gap-2">
    <Button size="sm" disabled={!canCreate} onclick={() => void create()}>{isBusy ? "Making the codebase…" : "Create codebase"}</Button>
    <Button size="sm" variant="ghost" disabled={isBusy} onclick={onClose}>Cancel</Button>
  </div>
</div>
