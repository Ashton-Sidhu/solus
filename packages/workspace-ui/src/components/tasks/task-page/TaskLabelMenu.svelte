<script lang="ts">
  import { Plus as PlusIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import LabelChip from "../../ui/LabelChip.svelte";
  import { Input } from "../../ui/input";
  import { addLabel } from "../lib/task-composer";

  let {
    labels,
    candidates,
    sheet = false,
    onSet,
  }: {
    labels: string[];
    candidates: string[];
    sheet?: boolean;
    onSet?: (labels: string[]) => Promise<void> | void;
  } = $props();

  let open = $state(false);
  let query = $state("");
  let trigger = $state<HTMLButtonElement | null>(null);
  let mutation = $state(false);

  const selected = $derived(new Set(labels.map((label) => label.toLowerCase())));
  const options = $derived.by(() => {
    const names = new Map<string, string>();
    for (const label of [...labels, ...candidates]) {
      const name = label.trim();
      if (name) names.set(name.toLowerCase(), name);
    }
    const needle = query.trim().toLowerCase();
    return [...names.values()]
      .filter((label) => !needle || label.toLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b));
  });
  const canCreate = $derived(
    !!query.trim() &&
      ![...selected, ...candidates.map((label) => label.toLowerCase())].includes(
        query.trim().toLowerCase(),
      ),
  );

  function handleOpenChange(next: boolean): void {
    open = next;
    if (!next) query = "";
  }

  async function toggle(label: string, checked: boolean): Promise<void> {
    if (!onSet || mutation) return;
    mutation = true;
    try {
      await onSet(
        checked
          ? addLabel(labels, label)
          : labels.filter((item) => item.toLowerCase() !== label.toLowerCase()),
      );
    } finally {
      mutation = false;
    }
  }

  async function createLabel(): Promise<void> {
    if (!onSet || !canCreate || mutation) return;
    mutation = true;
    try {
      await onSet(addLabel(labels, query));
      query = "";
    } finally {
      mutation = false;
    }
  }
</script>

<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1 {sheet ? 'justify-end' : ''}">
  {#each labels as label (label)}
    <LabelChip {label} />
  {/each}
  {#if onSet}
    <button
      bind:this={trigger}
      type="button"
      class="grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
      aria-label={labels.length ? "Edit labels" : "Add a label"}
      aria-haspopup="menu"
      aria-expanded={open}
      onclick={() => handleOpenChange(!open)}
    >
      <PlusIcon size={12} />
    </button>
  {:else if labels.length === 0}
    <span class="text-muted-foreground">None</span>
  {/if}
</div>

{#if onSet}
  <DropdownMenu.Root bind:open onOpenChange={handleOpenChange}>
    <DropdownMenu.Content
      customAnchor={trigger}
      side="bottom"
      align={sheet ? "end" : "start"}
      sideOffset={6}
      class="flex max-h-[min(28rem,calc(var(--bits-dropdown-menu-content-available-height,32rem)-1rem))] w-60 flex-col overflow-hidden pointer-fine:[.is-laptop-display_&]:w-52"
      aria-label="Edit task labels"
    >
      <div class="px-1 pb-1.5">
        <!-- svelte-ignore a11y_autofocus -->
        <Input
          autofocus
          dictation={false}
          value={query}
          oninput={(event) => (query = event.currentTarget.value)}
          onkeydown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && canCreate) {
              event.preventDefault();
              void createLabel();
            }
          }}
          placeholder="Search or create labels…"
          aria-label="Search or create labels"
          class="h-9 text-workspace-chrome pointer-fine:[.is-laptop-display_&]:h-8"
        />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {#each options as label (label)}
          <DropdownMenu.CheckboxItem
            checked={selected.has(label.toLowerCase())}
            disabled={mutation}
            closeOnSelect={false}
            onCheckedChange={(checked) => void toggle(label, checked)}
          >
            <span
              class="size-2.5 shrink-0 rounded-full bg-[color-mix(in_oklch,var(--solus-accent)_42%,var(--background))] pointer-fine:[.is-laptop-display_&]:size-2"
              aria-hidden="true"
            ></span>
            <span class="truncate">{label}</span>
          </DropdownMenu.CheckboxItem>
        {/each}
        {#if canCreate}
          <DropdownMenu.Item
            disabled={mutation}
            closeOnSelect={false}
            onclick={() => void createLabel()}
          >
            <PlusIcon size={12} class="shrink-0" />
            <span class="truncate">Create “{query.trim()}”</span>
          </DropdownMenu.Item>
        {:else if options.length === 0}
          <DropdownMenu.Item disabled>No matching labels</DropdownMenu.Item>
        {/if}
      </div>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
