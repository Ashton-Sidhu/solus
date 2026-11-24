<script lang="ts">
  /** One codebase on Settings → Codebases (docs/plans/codebases.md §9): its
   *  name, Delete, and its folders by host. Each host reads the repositories
   *  inside its folders from its disk, so each host's part has its own
   *  loading, stale, and error text. */
  import { onMount, tick, untrack } from "svelte";
  import { CODEBASE_ROOTS_MAX } from "@solus/contracts/codebases";
  import { ArrowLeft as ArrowLeftIcon, Plus as PlusIcon, RefreshCw as RefreshIcon } from "@lucide/svelte";
  import { codebasesStore } from "../../contexts";
  import { codebaseRootKey, rootRefusalText, rootRemovalRefusal } from "@solus/client-core/codebases";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { ListEmpty } from "../ui/list-page";
  import { RowCard } from "../ui/row-card";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import McpConfirmPopover from "../settings/McpConfirmPopover.svelte";
  import CodebaseRootPicker from "./CodebaseRootPicker.svelte";
  import CodebaseRootRow from "./CodebaseRootRow.svelte";
  import { codebaseSummary, countLabel, hostMembersNote, UNKNOWN_HOST_LABEL } from "./lib/codebase-view";
  import { RootPickerState } from "./lib/root-picker.svelte";

  let { codebaseId, onClose }: { codebaseId: string; onClose: () => void } = $props();

  const codebase = $derived(codebasesStore.codebaseOf(codebaseId));
  const groups = $derived(codebasesStore.membersOf(codebaseId));
  const isListLoading = $derived(codebasesStore.hosts.some((host) => host.isReady && host.status !== "ready" && host.status !== "unavailable"));
  const isRefreshing = $derived(groups.some((group) => group.state === "loading"));
  const isFull = $derived((codebase?.roots.length ?? 0) >= CODEBASE_ROOTS_MAX);
  // A codebase has two or more folders: one of the last two cannot be removed.
  const removalRefusal = $derived(codebase ? rootRemovalRefusal(codebase.roots) : null);

  $effect(() => {
    const shownId = codebaseId;
    return untrack(() => codebasesStore.watchMembers(shownId));
  });

  let backButtonEl = $state<HTMLElement | null>(null);
  let addButtonEl = $state<HTMLElement | null>(null);
  let deleteButtonEl = $state<HTMLElement | null>(null);
  onMount(() => backButtonEl?.focus({ preventScroll: true }));

  let isBusy = $state(false);
  /** The name while the person edits it. Null: the field shows the saved name. */
  let nameDraft = $state<string | null>(null);
  const name = $derived(nameDraft ?? codebase?.name ?? "");
  const isNameChanged = $derived(!!codebase && name.trim() !== "" && name.trim() !== codebase.name);

  let isAdding = $state(false);
  const picker = new RootPickerState(() => codebase?.roots ?? []);

  let isConfirmingDelete = $state(false);
  let deleteError = $state("");

  async function run(action: () => Promise<void>, failure: string): Promise<boolean> {
    if (isBusy) return false;
    isBusy = true;
    try {
      await action();
      return true;
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : failure);
      return false;
    } finally {
      isBusy = false;
    }
  }

  async function rename() {
    if (!isNameChanged) return;
    if (await run(async () => void (await codebasesStore.rename(codebaseId, name)), "Could not rename the codebase.")) nameDraft = null;
  }

  async function focusAddButton() {
    await tick();
    addButtonEl?.focus();
  }

  function closeAdding() {
    isAdding = false;
    picker.clear();
    void focusAddButton();
  }

  async function addChosenFolder() {
    const choice = picker.choice;
    if (!choice) return;
    if (await run(async () => void (await codebasesStore.addRoot(codebaseId, choice)), "Could not add the folder.")) closeAdding();
  }

  function addSuggestion(serverId: string | null, path: string) {
    if (!serverId) return;
    void run(async () => void (await codebasesStore.addRoot(codebaseId, { serverId, path })), "Could not add the folder.");
  }

  async function removeRoot(installationId: string, path: string) {
    await codebasesStore.removeRoot(codebaseId, { installationId, path });
    void focusAddButton();
  }

  async function remove() {
    if (isBusy) return;
    isBusy = true;
    deleteError = "";
    try {
      await codebasesStore.delete(codebaseId);
      isConfirmingDelete = false;
      onClose();
    } catch (error) {
      deleteError = error instanceof Error ? error.message : "Could not delete the codebase.";
    } finally {
      isBusy = false;
    }
  }

  function cancelAddingOnEscape(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // Escape closes this form, not Settings.
    event.preventDefault();
    event.stopPropagation();
    closeAdding();
  }
</script>

<div class="flex flex-col gap-8">
  <div class="flex flex-wrap items-center gap-3">
    <Button bind:ref={backButtonEl} size="sm" variant="ghost" onclick={onClose}><ArrowLeftIcon size={14} /> Codebases</Button>
    <h2 class="text-lg font-medium">{codebase?.name ?? "Codebase"}</h2>
    {#if codebase}
      <span class="text-sm text-muted-foreground">{codebaseSummary(codebase, (installationId) => codebasesStore.hostOf(installationId))}</span>
    {/if}
  </div>

  {#if !codebase}
    <p class="text-sm text-muted-foreground" role="status">
      {isListLoading ? "Loading the codebase…" : "This codebase does not exist. It can be deleted, or it is on a host that is not connected."}
    </p>
  {:else}
    <SettingsSection label="Codebase">
      <SettingsRow label="Name" description="A short name for this set of folders.">
        {#snippet control()}
          <Input
            bind:value={() => name, (next) => (nameDraft = next)}
            class="h-7 w-56"
            aria-label="Codebase name"
            maxlength={200}
            disabled={isBusy}
            onSubmit={() => void rename()}
          />
          <Button size="sm" variant="outline" disabled={isBusy || !isNameChanged} onclick={() => void rename()}>Rename</Button>
        {/snippet}
      </SettingsRow>
      <SettingsRow label="Delete this codebase" description="The codebase is deleted on each host. No file is deleted.">
        {#snippet control()}
          <Button
            bind:ref={deleteButtonEl}
            size="sm"
            variant="destructive"
            disabled={isBusy}
            onclick={() => {
              deleteError = "";
              isConfirmingDelete = true;
            }}
          >
            Delete
          </Button>
          <McpConfirmPopover
            bind:open={isConfirmingDelete}
            anchor={deleteButtonEl}
            title="Delete {codebase.name}?"
            text="The codebase is deleted on each host. Its folders and their files stay where they are: no file is deleted."
            action="Delete"
            busyAction="Deleting…"
            {isBusy}
            error={deleteError}
            onConfirm={() => void remove()}
          />
        {/snippet}
      </SettingsRow>
    </SettingsSection>

    <SettingsSection
      label="Folders"
      description="Each host reads the repositories inside its folders from its disk. A repository that you clone into a folder is found on the next read."
      plain
    >
      {#snippet action()}
        <div class="flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={isRefreshing || groups.length === 0} onclick={() => void codebasesStore.refreshMembers(codebaseId)}>
            <RefreshIcon size={14} />
            {isRefreshing ? "Reading…" : "Refresh"}
          </Button>
          <Button bind:ref={addButtonEl} size="sm" variant="outline" disabled={isBusy || isAdding || isFull} onclick={() => (isAdding = true)}>
            <PlusIcon size={14} /> Add folder
          </Button>
        </div>
      {/snippet}

      {#if isFull}
        <p class="text-[13px] leading-[1.45] text-(--solus-text-secondary)">{rootRefusalText("limit")}</p>
      {/if}
      {#if removalRefusal}
        <p id="codebase-removal-refusal" class="text-[13px] leading-[1.45] text-(--solus-text-secondary)">{rootRefusalText(removalRefusal)}</p>
      {/if}

      {#if isAdding}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          role="group"
          aria-label="Add a folder"
          class="flex flex-col gap-3 rounded-xl border border-border bg-background p-4 dark:bg-card"
          onkeydown={cancelAddingOnEscape}
        >
          <CodebaseRootPicker {picker} disabled={isBusy} />
          <div class="flex items-center gap-2">
            <Button size="sm" disabled={isBusy || !picker.choice} onclick={() => void addChosenFolder()}>Add folder</Button>
            <Button size="sm" variant="ghost" disabled={isBusy} onclick={closeAdding}>Cancel</Button>
          </div>
        </div>
      {/if}

      {#if groups.length === 0}
        <ListEmpty title="This codebase has no folders.">Add a folder on one of your hosts.</ListEmpty>
      {/if}

      {#each groups as group (group.installationId)}
        {@const note = hostMembersNote(group)}
        <div class="flex flex-col gap-2">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 class="text-sm font-medium text-foreground">{group.label ?? UNKNOWN_HOST_LABEL}</h3>
            <span class="text-xs text-muted-foreground">{countLabel(group.roots.length, "folder", "folders")}</span>
            {#if group.isStale}
              <span class="rounded-full border border-(--warning) px-2 text-xs text-(--warning)">Not current</span>
            {/if}
          </div>
          {#if note}
            <p
              class="text-[13px] leading-[1.45] {note.tone === 'error' ? 'text-destructive' : 'text-(--solus-text-secondary)'}"
              role={note.isBusy ? "status" : note.tone === "error" ? "alert" : undefined}
            >
              {note.text}
            </p>
          {/if}
          <RowCard>
            {#each group.roots as entry (codebaseRootKey(entry.root))}
              <CodebaseRootRow
                {entry}
                canAdd={group.presence === "ready" && !isFull}
                {isBusy}
                canRemove={!removalRefusal}
                onRemove={() => removeRoot(entry.root.installationId, entry.root.path)}
                onAddSuggestion={(path) => addSuggestion(group.serverId, path)}
              />
            {/each}
          </RowCard>
        </div>
      {/each}
    </SettingsSection>
  {/if}
</div>
