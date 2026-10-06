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
  let listEl = $state<HTMLDivElement | null>(null);

  // bits-ui moves DOM focus to a row on every mouse move and back to the menu
  // when the pointer leaves a row. With a search field, that pulls focus out of
  // the field while the reader types, so the rows only take a hover wash and
  // the field keeps focus. The keyboard still reaches the rows with ↓.
  function keepSearchFocus(event: PointerEvent): void {
    if (group.searchable) event.preventDefault();
  }

  function onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      listEl?.querySelector<HTMLElement>('[data-slot="dropdown-menu-radio-item"]')?.focus();
      return;
    }
    if (event.key === "Enter" && visibleOptions[0]) {
      event.preventDefault();
      group.select(visibleOptions[0].value);
    }
    // The menu's typeahead would otherwise move focus to a matching row.
    event.stopPropagation();
  }
</script>

<DropdownMenu.SubContent
  class="flex max-h-[min(28rem,calc(var(--bits-dropdown-menu-content-available-height,36rem)-1rem))] flex-col overflow-hidden p-2 {group.searchable
    ? 'w-80'
    : group.key === 'labels'
      ? 'w-80'
      : 'w-72'}"
>
  {#if group.searchable}
    <!-- A search row, not a boxed field: the hairline under it separates it
         from the results, as a command list does. -->
    <div
      class="-mx-2 -mt-2 mb-1.5 flex h-10 shrink-0 items-center gap-2 border-b border-[var(--hairline)] px-[1.125rem]"
    >
      <span class="grid size-5 shrink-0 place-items-center text-muted-foreground">
        <SearchIcon size={15} />
      </span>
      <!-- The author submenu opens for this search task, so focus belongs in
           the field instead of on the first result. -->
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={query}
        autofocus
        type="text"
        onkeydown={onSearchKeydown}
        placeholder={`Search ${group.label.toLowerCase()}`}
        aria-label={`Search ${group.label.toLowerCase()}`}
        class="min-w-0 flex-1 border-0 bg-transparent text-menu text-foreground caret-[var(--primary)] outline-none placeholder:text-muted-foreground"
      />
    </div>
  {:else}
    <DropdownMenu.Label>{group.label}</DropdownMenu.Label>
  {/if}
  <div bind:this={listEl} class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    <DropdownMenu.RadioGroup value={group.value} onValueChange={group.select}>
      {#each visibleOptions as option (option.value)}
        {@const Icon = option.icon}
        <DropdownMenu.RadioItem
          value={option.value}
          onpointermove={keepSearchFocus}
          onpointerleave={keepSearchFocus}
        >
          <!-- One 20px leading slot for every mark, so each label starts on
               the same line whether it follows an avatar, a dot or a glyph. -->
          <span class="grid size-5 shrink-0 place-items-center text-muted-foreground">
            {#if group.key === "author" && option.value}
              <PrAvatar name={option.label} url={option.avatarUrl} size="size-5 text-[9px]" />
            {:else if option.color}
              <!-- Keep label marks quieter than action glyphs. They use the
                   same host colour as the row chip, mixed into the surface so
                   the result stays pastel in both themes. -->
              <span
                class="size-2.5 rounded-full bg-[color-mix(in_oklch,var(--label-color)_42%,var(--background))]"
                style="--label-color: {option.color}"
              ></span>
            {:else if Icon}
              <Icon size={15} />
            {:else if option.value === ""}
              <AllIcon size={15} />
            {/if}
          </span>
          <span class="min-w-0 flex-1 truncate">{option.label}</span>
          {#if option.count !== undefined}
            <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{option.count}</span>
          {/if}
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
    {#if visibleOptions.length === 0}
      <div class="px-2.5 py-3 text-menu text-muted-foreground">No matches.</div>
    {/if}
  </div>
</DropdownMenu.SubContent>
