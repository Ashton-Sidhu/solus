<script lang="ts" generics="T extends string">
  import { CaretDownIcon } from "phosphor-svelte";
  import * as DropdownMenu from "./dropdown-menu";
  import { PAGE_GHOST_BTN } from "../../lib/page-chrome";
  import { cn } from "@renderer/lib/utils.js";

  /** Borderless sort trigger + listbox dropdown for command bars. */
  interface Props {
    options: { value: T; label: string }[];
    value: T;
    ariaLabel?: string;
    /** Overrides on the trigger — e.g. the PR bar's filled 32px form. */
    class?: string;
  }
  let {
    options,
    value = $bindable(),
    ariaLabel = "Sort",
    class: className,
  }: Props = $props();

  let open = $state(false);
  const label = $derived(options.find((o) => o.value === value)?.label ?? "");
</script>

<div class="relative flex shrink-0 items-center">
  <DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class={cn(
            PAGE_GHOST_BTN,
            "px-2 py-1 [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-2.5",
            className,
          )}
          aria-label={ariaLabel}
        >
          <span>{label}</span>
          <CaretDownIcon size={9} class="shrink-0" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="top" align="end" sideOffset={6} class="w-[140px]">
      <DropdownMenu.RadioGroup bind:value>
      {#each options as opt (opt.value)}
        <DropdownMenu.RadioItem value={opt.value}>
          {opt.label}
        </DropdownMenu.RadioItem>
      {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>
