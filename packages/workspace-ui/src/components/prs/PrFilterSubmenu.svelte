<script lang="ts">
  import { Layers as AllIcon, Search as SearchIcon } from "@lucide/svelte";
  import type { PrFilterGroup } from "./lib/pr-filter-menu";
  import PrAvatar from "./PrAvatar.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";

  let { group }: { group: PrFilterGroup } = $props();
  let query = $state("");
  const visibleOptions = $derived(
    query.trim()
      ? group.options.filter((option) =>
          option.label.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : group.options,
  );
</script>

<DropdownMenu.SubContent
  class="flex max-h-[min(32rem,calc(var(--bits-dropdown-menu-content-available-height,36rem)-1rem))] flex-col overflow-hidden p-2 {group.searchable
    ? 'w-96 pointer-fine:[.is-laptop-display_&]:w-80'
    : group.key === 'labels'
      ? 'w-80 pointer-fine:[.is-laptop-display_&]:w-72'
      : 'w-72 pointer-fine:[.is-laptop-display_&]:w-60'}"
>
  <div class="px-2 pt-0.5 pb-1.5 text-menu text-muted-foreground">{group.label}</div>
  {#if group.searchable}
    <div
      class="mb-1.5 flex h-9 items-center gap-2 rounded-lg bg-card px-2.5 shadow-[shadow:var(--elev-ring)] focus-within:shadow-[0_0_0_2px_color-mix(in_oklch,var(--primary)_70%,transparent)] pointer-fine:[.is-laptop-display_&]:h-8 pointer-fine:[.is-laptop-display_&]:rounded-md pointer-fine:[.is-laptop-display_&]:px-2"
    >
      <SearchIcon size={16} class="shrink-0 text-muted-foreground" />
      <!-- The author submenu opens for this search task, so focus belongs in
           the field instead of on the first result. -->
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={query}
        autofocus
        type="text"
        onkeydown={(event) => event.stopPropagation()}
        placeholder={`Search ${group.label.toLowerCase()}`}
        aria-label={`Search ${group.label.toLowerCase()}`}
        class="min-w-0 flex-1 bg-transparent text-menu outline-none placeholder:text-muted-foreground"
      />
    </div>
  {/if}
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    <DropdownMenu.RadioGroup value={group.value} onValueChange={group.select}>
      {#each visibleOptions as option (option.value)}
        {@const Icon = option.icon}
        <DropdownMenu.RadioItem
          value={option.value}
          class="data-[state=checked]:bg-[var(--solus-menu-hover-ink)]"
        >
          {#if group.key === "author" && option.value}
            <PrAvatar name={option.label} url={option.avatarUrl} size="size-5 text-[9px]" />
          {:else if option.color}
            <!-- Keep label marks quieter than action glyphs. They use the
                 same host colour as the row chip, mixed into the surface so
                 the result stays pastel in both themes. -->
            <span
              class="size-2.5 shrink-0 rounded-full bg-[color-mix(in_oklch,var(--label-color)_42%,var(--background))] pointer-fine:[.is-laptop-display_&]:size-2"
              style="--label-color: {option.color}"
            ></span>
          {:else if Icon}
            <Icon size={15} class="shrink-0" />
          {:else if option.value === ""}
            <AllIcon size={15} class="shrink-0" />
          {/if}
          <span class="min-w-0 flex-1 truncate">{option.label}</span>
          {#if option.count !== undefined}
            <span class="mr-1 shrink-0 tabular-nums text-muted-foreground">
              {group.key === "author"
                ? `${option.count} pull request${option.count === 1 ? "" : "s"}`
                : option.count}
            </span>
          {/if}
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
    {#if visibleOptions.length === 0}
      <div class="px-2 py-3 text-menu text-muted-foreground">No matches.</div>
    {/if}
  </div>
</DropdownMenu.SubContent>
