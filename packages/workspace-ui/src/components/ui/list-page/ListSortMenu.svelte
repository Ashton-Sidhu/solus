<script lang="ts" generics="T extends string">
  import { ArrowUpDown as ArrowUpDownIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../dropdown-menu";
  import { useScope } from "../../../lib/keybindings/use-keybinding.svelte";

  let { value = $bindable(), options, ariaLabel = "Sort" }: {
    value: T;
    options: { value: T; label: string }[];
    ariaLabel?: string;
  } = $props();
  let open = $state(false);
  useScope("list-filters", { exclusive: true, active: () => open });
</script>

    <DropdownMenu.Root bind:open={open}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="relative flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-card px-2 text-foreground shadow-[shadow:var(--elev-ring)] hover:bg-[var(--wash-1)] @min-[40rem]/pane:pr-3 @max-[30rem]/pane:h-10"
            aria-label={ariaLabel}
            title="Sort"
          >
            <ArrowUpDownIcon size={16} class="shrink-0 text-muted-foreground" />
            <span class="@max-[40rem]/pane:hidden">Sort</span>
            <span
              class="pointer-events-none absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
              aria-hidden="true"
            ></span>
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[150px]">
        <DropdownMenu.RadioGroup bind:value={value}>
          {#each options as option (option.value)}
            <DropdownMenu.RadioItem value={option.value}>
              {option.label}
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>