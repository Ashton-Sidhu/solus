<script lang="ts">
  /** One codebase on Settings → Codebases (docs/plans/codebases.md §9): its
   *  name, Delete, and its folders by host. Each host reads the repositories
   *  inside its folders from its disk, so each host's part has its own
   *  loading, stale, and error text. */
  import { onMount, tick, untrack } from "svelte";
  import { CODEBASE_ROOTS_MAX } from "@solus/contracts/codebases";
  import { Plus as PlusIcon, RefreshCw as RefreshIcon } from "@lucide/svelte";
  import { codebasesStore } from "../../contexts";
  import { codebaseRootKey, rootRefusalText } from "@solus/client-core/codebases";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { ListEmpty } from "../ui/list-page";
  import { RowCard } from "../ui/row-card";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import McpConfirmPopover from "../settings/McpConfirmPopover.svelte";
  import DirectoryPicker from "../pickers/DirectoryPicker.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { serverConnections } from "@solus/client-core/server-connections";
  import CodebaseRootRow from "./CodebaseRootRow.svelte";
  import { countLabel, hostMembersNote, UNKNOWN_HOST_LABEL } from "./lib/codebase-view";
  import { RootPickerState } from "./lib/root-picker.svelte";

  let { codebaseId, onClose }: { codebaseId: string; onClose: () => void } = $props();

  const codebase = $derived(codebasesStore.codebaseOf(codebaseId));
  const groups = $derived(codebasesStore.membersOf(codebaseId));
  const isListLoading = $derived(codebasesStore.hosts.some((host) => host.isReady && host.status !== "ready" && host.status !== "unavailable"));
  const isRefreshing = $derived(groups.some((group) => group.state === "loading"));
  const isFull = $derived((codebase?.roots.length ?? 0) >= CODEBASE_ROOTS_MAX);

  $effect(() => {
    const shownId = codebaseId;
    return untrack(() => codebasesStore.watchMembers(shownId));
  });

  let pageEl = $state<HTMLElement | null>(null);
  let addButtonEl = $state<HTMLElement | null>(null);
  let deleteButtonEl = $state<HTMLElement | null>(null);
  // The row that opened this page is gone: keep focus in the page, not on the body.
  onMount(() => pageEl?.focus({ preventScroll: true }));

  let isBusy = $state(false);
  /** The name while the person edits it. Null: the field shows the saved name. */
  let nameDraft = $state<string | null>(null);
  const name = $derived(nameDraft ?? codebase?.name ?? "");
  const isNameChanged = $derived(!!codebase && name.trim() !== "" && name.trim() !== codebase.name);

  /** The folder browser is open on `picker.host`. */
  let isBrowsing = $state(false);
  /** A chosen folder is being read, then added. */
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

  /** Saves the draft. An empty or unchanged draft goes back to the saved name. */
  async function rename() {
    if (!isNameChanged) {
      nameDraft = null;
      return;
    }
    if (await run(async () => void (await codebasesStore.rename(codebaseId, name)), "Could not rename the codebase.")) nameDraft = null;
  }

  function revertNameOnEscape(event: KeyboardEvent) {
    if (event.key !== "Escape" || nameDraft === null) return;
    // Escape undoes the edit first; a second Escape closes Settings.
    event.preventDefault();
    event.stopPropagation();
    nameDraft = null;
  }

  async function focusAddButton() {
    await tick();
    addButtonEl?.focus();
  }

  function browseOn(serverId: string) {
    picker.chooseHost(serverId);
    isBrowsing = true;
  }

  function closeBrowser() {
    isBrowsing = false;
    void focusAddButton();
  }

  /** One step from the folder browser: the host reads the folder, and it is added when it can be. */
  async function addFolder(path: string) {
    isBrowsing = false;
    isAdding = true;
    try {
      await picker.scanFolder(path);
      const choice = picker.choice;
      if (choice) await run(async () => void (await codebasesStore.addRoot(codebaseId, choice)), "Could not add the folder.");
      else toasts.error(picker.problemText ?? "Could not add the folder.");
    } finally {
      isAdding = false;
      picker.clear();
      void focusAddButton();
    }
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

</script>

<!-- The settings header names this codebase, and its Codebases crumb goes back to the list. -->
<div bind:this={pageEl} tabindex="-1" class="flex flex-col gap-8 outline-none">
  {#if !codebase}
    <p class="text-sm text-muted-foreground" role="status">
      {isListLoading ? "Loading the codebase…" : "This codebase does not exist. It can be deleted, or it is on a host that is not connected."}
    </p>
  {:else}
    <SettingsSection label="Codebase">
      <SettingsRow label="Name" description="A short name for this set of folders. Press Enter to save it.">
        {#snippet control()}
          <Input
            bind:value={() => name, (next) => (nameDraft = next)}
            class="h-8 w-64 shadow-[inset_0_0_0_1px_var(--input)]"
            aria-label="Codebase name"
            maxlength={200}
            submitOn="enter"
            onSubmit={() => void rename()}
            onblur={() => void rename()}
            onkeydown={revertNameOnEscape}
          />
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
          {#if picker.hosts.length > 1}
            <!-- More than one host: the menu chooses the host, and the folder browser opens on it. -->
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <Button {...props} bind:ref={addButtonEl} size="sm" variant="outline" disabled={isBusy || isAdding || isFull}>
                    <PlusIcon size={14} /> {isAdding ? "Adding…" : "Add folder"}
                  </Button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[min(16rem,calc(100vw-2rem))]">
                <DropdownMenu.Label class="text-chrome-dense text-muted-foreground">Add a folder on</DropdownMenu.Label>
                {#each picker.hosts as host (host.serverId)}
                  <DropdownMenu.Item onSelect={() => browseOn(host.serverId)}>{host.label}</DropdownMenu.Item>
                {/each}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          {:else}
            <Button
              bind:ref={addButtonEl}
              size="sm"
              variant="outline"
              disabled={isBusy || isAdding || isFull || !picker.host}
              onclick={() => picker.host && browseOn(picker.host.serverId)}
            >
              <PlusIcon size={14} /> {isAdding ? "Adding…" : "Add folder"}
            </Button>
          {/if}
        </div>
      {/snippet}

      {#if isFull}
        <p class="text-[13px] leading-[1.45] text-(--solus-text-secondary)">{rootRefusalText("limit")}</p>
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

{#if picker.host}
  {@const host = picker.host}
  {#key host.serverId}
    <DirectoryPicker
      bind:open={isBrowsing}
      onClose={closeBrowser}
      onSelect={(path) => void addFolder(path)}
      title="Add a folder to {codebase?.name ?? 'the codebase'}"
      actionLabel="Add this folder"
      api={serverConnections.apiFor(host.serverId)}
      serverId={host.serverId}
      hostLabel={host.label}
    />
  {/key}
{/if}

