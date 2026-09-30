<script lang="ts">
  import { FolderPlus as FolderPlusIcon, Pen as PencilSimpleIcon, Trash2 as TrashIcon } from "@lucide/svelte";
  import { Input } from "../ui/input";
  import { Button } from "../ui/button";
  import type { DirectoryEdits } from "./lib/directory-edits.svelte";

  interface Props {
    edits: DirectoryEdits;
    /** Focus goes back to the picker's filter once the edit ends. */
    onSettled: () => void;
  }

  let { edits, onSettled }: Props = $props();

  const edit = $derived(edits.edit);
  let nameInputEl: HTMLInputElement | HTMLTextAreaElement | null = $state(null);
  let confirmEl: HTMLButtonElement | null = $state(null);

  // A new strip takes the keyboard at once: the name is selected for typing
  // over, and a confirmation is answered with ↵.
  $effect(() => {
    if (!edit) return;
    if (edit.kind === "create" || edit.kind === "rename") {
      requestAnimationFrame(() => nameInputEl?.select());
    } else {
      requestAnimationFrame(() => confirmEl?.focus());
    }
  });

  function cancel() {
    edits.cancel();
    onSettled();
  }

  async function commit() {
    await edits.commit();
    if (!edits.edit) onSettled();
  }

  function handleKeyDown(e: KeyboardEvent) {
    // The dialog's own handler reads ↑↓←/Backspace as folder navigation,
    // which would eat ordinary text editing here.
    if (e.key === "Tab") return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    }
  }
</script>

{#if edit}
  {@const message = edits.error ?? edits.nameProblem}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="mt-2 flex flex-col gap-1.5 rounded-lg bg-card px-2.5 py-2 shadow-[shadow:var(--elev-ring)]"
    role="group"
    aria-label={edit.kind === "create" ? "New folder" : edit.kind === "rename" ? "Rename folder" : "Remove folder"}
    onkeydown={handleKeyDown}
  >
    <div class="flex min-w-0 items-center gap-2 max-md:flex-wrap">
      {#if edit.kind === "create" || edit.kind === "rename"}
        {#if edit.kind === "create"}
          <FolderPlusIcon size={14} class="shrink-0 text-primary" />
        {:else}
          <PencilSimpleIcon size={14} class="shrink-0 text-muted-foreground" />
        {/if}
        <!-- 16px on a phone: iOS zooms into any smaller input and stays zoomed. -->
        <Input
          bind:ref={nameInputEl}
          value={edit.name}
          type="text"
          class="h-7 min-w-0 flex-1 text-[0.8125rem] max-md:h-10 max-md:basis-full max-md:text-base"
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          dictation={false}
          aria-label={edit.kind === "create" ? "New folder name" : "New name"}
          aria-invalid={!!message}
          oninput={(e) => edits.setName(e.currentTarget.value)}
        />
      {:else}
        <TrashIcon size={14} class="shrink-0 text-destructive" />
        <span class="min-w-0 flex-1 text-pretty text-xs max-md:basis-full max-md:text-[0.8125rem]">
          {#if edit.kind === "trash"}
            Move “{edit.entry.name}” to the Trash?
          {:else}
            This host has no Trash. Delete “{edit.entry.name}” and everything in it permanently?
          {/if}
        </span>
      {/if}
      <div class="flex shrink-0 items-center gap-1.5 max-md:ml-auto">
        <Button variant="ghost" size="sm" class="text-[0.8125rem]" onclick={cancel}>Cancel</Button>
        <Button
          bind:ref={confirmEl}
          variant={edit.kind === "trash" || edit.kind === "delete" ? "destructive" : "default"}
          size="sm"
          class="text-[0.8125rem]"
          disabled={edits.isBusy || !!edits.nameProblem}
          onclick={() => void commit()}
        >
          {#if edit.kind === "create"}Create
          {:else if edit.kind === "rename"}Rename
          {:else if edit.kind === "trash"}Move to Trash
          {:else}Delete permanently{/if}
        </Button>
      </div>
    </div>
    {#if message}
      <span class="text-pretty text-xs text-(--solus-status-error)" role="alert">{message}</span>
    {/if}
  </div>
{/if}
