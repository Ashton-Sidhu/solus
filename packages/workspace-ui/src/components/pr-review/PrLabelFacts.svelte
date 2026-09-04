<script lang="ts">
  import { Plus as PlusIcon, Tag as TagIcon } from "@lucide/svelte";
  import type { PrLabel } from "@solus/contracts/providers";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import LabelChip from "../ui/LabelChip.svelte";
  import { Input } from "../ui/input";
  import { labelChipColor } from "../prs/lib/prs-list-view";

  let {
    labels,
    candidates,
    loading = false,
    loadFailed = false,
    mutation = false,
    onOpen,
    onSet,
  }: {
    labels: PrLabel[];
    candidates: PrLabel[];
    loading?: boolean;
    loadFailed?: boolean;
    mutation?: boolean;
    onOpen?: () => void;
    onSet?: (names: string[]) => void;
  } = $props();

  let open = $state(false);
  let query = $state("");
  let trigger = $state<HTMLButtonElement | null>(null);

  const selected = $derived(new Set(labels.map((label) => label.name.toLowerCase())));
  const available = $derived(
    candidates.filter((label) =>
      label.name.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );

  function handleOpenChange(next: boolean): void {
    open = next;
    if (next) onOpen?.();
    else query = "";
  }

  function toggle(label: PrLabel, checked: boolean): void {
    if (!onSet || mutation) return;
    const names = checked
      ? [...labels.map((item) => item.name), label.name]
      : labels.filter((item) => item.name !== label.name).map((item) => item.name);
    onSet([...new Set(names)]);
  }
</script>

<dt class="flex items-center gap-2">
  <TagIcon size={12} class="shrink-0 opacity-80" aria-hidden="true" />
  Labels
</dt>
<dd class="flex min-h-6 min-w-0 flex-wrap items-center gap-1">
  {#each labels as label (label.name)}
    <LabelChip label={label.name} color={labelChipColor(label.color)} />
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
    <span>None</span>
  {/if}
</dd>

{#if onSet}
  <DropdownMenu.Root bind:open onOpenChange={handleOpenChange}>
    <DropdownMenu.Content
      customAnchor={trigger}
      side="bottom"
      align="start"
      sideOffset={6}
      class="flex max-h-[min(28rem,calc(var(--bits-dropdown-menu-content-available-height,32rem)-1rem))] w-60 flex-col overflow-hidden pointer-fine:[.is-laptop-display_&]:w-52"
      aria-label="Edit pull request labels"
    >
      <div class="px-1 pb-1.5">
        <!-- svelte-ignore a11y_autofocus -->
        <Input
          autofocus
          dictation={false}
          value={query}
          oninput={(event) => (query = event.currentTarget.value)}
          onkeydown={(event) => event.stopPropagation()}
          placeholder="Search labels…"
          aria-label="Search labels"
          class="h-9 text-workspace-chrome pointer-fine:[.is-laptop-display_&]:h-8"
        />
      </div>
      {#if loading}
        <DropdownMenu.Item disabled>Loading labels…</DropdownMenu.Item>
      {:else if loadFailed}
        <DropdownMenu.Item disabled>Couldn’t load labels</DropdownMenu.Item>
      {:else if available.length === 0}
        <DropdownMenu.Item disabled>{query ? "No matching labels" : "No labels available"}</DropdownMenu.Item>
      {:else}
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {#each available as label (label.name)}
            <DropdownMenu.CheckboxItem
              checked={selected.has(label.name.toLowerCase())}
              disabled={mutation}
              closeOnSelect={false}
              onCheckedChange={(checked) => toggle(label, checked)}
            >
              <span
                class="size-2.5 shrink-0 rounded-full bg-[color-mix(in_oklch,var(--label-color)_42%,var(--background))] pointer-fine:[.is-laptop-display_&]:size-2"
                style="--label-color: {labelChipColor(label.color)}"
                aria-hidden="true"
              ></span>
              <span class="truncate">{label.name}</span>
            </DropdownMenu.CheckboxItem>
          {/each}
        </div>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
