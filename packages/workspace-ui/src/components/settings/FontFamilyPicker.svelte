<script lang="ts">
  import { Check as CheckIcon, ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import * as Command from "../ui/command";
  import { MenuSearch } from "../ui/menu";
  import * as Popover from "../ui/popover";
  import { fontCatalog } from "./lib/font-catalog.svelte";
  import {
    filterInstalledFamilies,
    filterPresets,
    fontPreferenceLabel,
    typedFamilyVerdict,
    type FontPreset,
  } from "./lib/font-picker";

  /**
   * One control for every font row: the bundled presets, then every family
   * installed on this client, the way a native editor lists system fonts.
   * Where the engine cannot list fonts (Safari, Firefox, mobile) or the user
   * declined, the search field doubles as a name entry — type a family and
   * commit it — so no client is limited to the presets.
   */
  interface Props {
    value: string;
    presets: readonly FontPreset[];
    ariaLabel: string;
    /** Code surfaces sit on a column grid; a proportional face is refused. */
    requireMonospace?: boolean;
    onSelect: (value: string) => void;
  }

  let {
    value,
    presets,
    ariaLabel,
    requireMonospace = false,
    onSelect,
  }: Props = $props();

  let open = $state(false);
  let query = $state("");

  const label = $derived(fontPreferenceLabel(value, presets));
  const visiblePresets = $derived(filterPresets(presets, query));
  const installed = $derived(
    fontCatalog.status === "granted"
      ? filterInstalledFamilies(fontCatalog.families, query, requireMonospace)
      : [],
  );
  const typed = $derived(
    typedFamilyVerdict(query, presets, fontCatalog.families, requireMonospace),
  );
  const isEmpty = $derived(
    visiblePresets.length === 0 && installed.length === 0 && typed.kind === "none",
  );

  // A granted permission needs no gesture, so the list is ready on first open.
  fontCatalog.probeGrantedPermission();

  function handleOpenChange(next: boolean): void {
    open = next;
    // The click that opened the menu is the gesture the permission prompt needs.
    if (next) fontCatalog.discover();
    else query = "";
  }

  function choose(next: string): void {
    handleOpenChange(false);
    onSelect(next);
  }
</script>

<Popover.Root bind:open onOpenChange={handleOpenChange}>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="outline"
        size="sm"
        aria-label={ariaLabel}
        class="min-w-28 max-w-56 justify-between text-xs font-normal shadow-xs"
      >
        <span class="truncate">{label}</span>
        <CaretDownIcon size={11} style="opacity:0.6" />
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    data-solus-ui
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    class="menu-surface z-[10002] w-[min(18rem,calc(100vw-2rem))] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0 [&_.menu-row]:text-workspace-chrome [&_[data-slot=command-input]]:text-workspace-chrome"
    aria-label={ariaLabel}
  >
    <Command.Root
      shouldFilter={false}
      class="h-auto min-h-0 [&>[data-slot=command-list]]:min-h-0 [&>div:first-child]:shrink-0"
    >
      <MenuSearch
        bind:value={query}
        placeholder={fontCatalog.status === "granted"
          ? "Search fonts"
          : "Search, or type a font name"}
      />
      <Command.List
        class="max-h-[min(20rem,calc(var(--bits-popover-content-available-height,22rem)-3rem))] overflow-y-auto overscroll-contain p-1.5"
      >
        {#if isEmpty}
          <p class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)">
            No matching fonts
          </p>
        {/if}
        {#if visiblePresets.length > 0}
          <Command.Group heading="Presets">
            {#each visiblePresets as preset (preset.id)}
              <Command.Item
                value="preset:{preset.id}"
                onSelect={() => choose(preset.id)}
                data-menu-current={value === preset.id ? "" : undefined}
              >
                <span class="min-w-0 flex-1 truncate">{preset.label}</span>
                {#if value === preset.id}
                  <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
                {/if}
              </Command.Item>
            {/each}
          </Command.Group>
        {/if}
        {#if installed.length > 0}
          <Command.Group heading="Installed">
            {#each installed as family (family)}
              <Command.Item
                value="installed:{family}"
                onSelect={() => choose(family)}
                data-menu-current={value === family ? "" : undefined}
              >
                <!-- Each row previews itself; the name is the specimen. -->
                <span
                  class="min-w-0 flex-1 truncate"
                  style:font-family={`"${family}"`}>{family}</span
                >
                {#if value === family}
                  <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
                {/if}
              </Command.Item>
            {/each}
          </Command.Group>
        {/if}
        {#if typed.kind !== "none"}
          <Command.Group heading="Typed">
            {#if typed.kind === "ok"}
              <Command.Item
                value="custom:{typed.family}"
                onSelect={() => choose(typed.family)}
              >
                <span class="min-w-0 flex-1 truncate">Use “{typed.family}”</span>
              </Command.Item>
            {:else}
              <Command.Item value="custom:{typed.family}" disabled>
                <span class="min-w-0 flex-1 truncate">“{typed.family}”</span>
                <span class="shrink-0 text-xs text-(--solus-text-tertiary)">
                  {typed.kind === "not-installed" ? "Not installed" : "Not monospace"}
                </span>
              </Command.Item>
            {/if}
          </Command.Group>
        {/if}
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
