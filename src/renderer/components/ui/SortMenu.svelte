<script lang="ts" generics="T extends string">
  import { CaretDownIcon } from "phosphor-svelte";
  import Dropdown from "./Dropdown.svelte";
  import DropdownItem from "./DropdownItem.svelte";
  import { PAGE_GHOST_BTN } from "../../lib/page-chrome";

  /** Borderless sort trigger + listbox dropdown for command bars. */
  interface Props {
    options: { value: T; label: string }[];
    value: T;
    ariaLabel?: string;
  }
  let { options, value = $bindable(), ariaLabel = "Sort" }: Props = $props();

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  const label = $derived(options.find((o) => o.value === value)?.label ?? "");
</script>

<div class="relative flex shrink-0 items-center">
  <button
    type="button"
    bind:this={triggerEl}
    class="{PAGE_GHOST_BTN} px-2 py-1 [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-2.5"
    aria-label={ariaLabel}
    aria-haspopup="listbox"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <span>{label}</span>
    <CaretDownIcon size={9} class="shrink-0" />
  </button>
  <Dropdown bind:open triggerEl={triggerEl} align="top" anchor="right" width={140}>
    <div class="py-1" role="listbox" aria-label={ariaLabel}>
      {#each options as opt (opt.value)}
        <DropdownItem
          selected={value === opt.value}
          onclick={() => {
            value = opt.value;
            open = false;
          }}
        >
          {opt.label}
        </DropdownItem>
      {/each}
    </div>
  </Dropdown>
</div>
