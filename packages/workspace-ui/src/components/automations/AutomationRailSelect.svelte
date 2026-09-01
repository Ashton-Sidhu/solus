<script lang="ts" generics="T extends string">
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { VALUE_TRIGGER } from "./lib/rail-styles";

  /** An editable value in the detail view's rail.
   *
   *  Same picker language as the input bar's model chip and permission mode:
   *  a borderless chip that washes on hover, a caret to mark it editable, and a
   *  radio menu on the shared menu surface. Selection commits immediately, so
   *  this emits `onSelect` rather than binding a value. */
  interface Props {
    /** Names the control for screen readers — the visible label is the rail row
     *  to the left of it, which the button itself doesn't own. */
    label: string;
    value: T;
    options: { value: T; label: string }[];
    onSelect: (value: T) => void;
    /** Menu width. Long label sets (models, agents) need more room than the
     *  default; the caller knows which. */
    menuClass?: string;
  }
  let { label, value, options, onSelect, menuClass = "w-[176px]" }: Props = $props();

  const current = $derived(options.find((o) => o.value === value)?.label ?? "");
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button {...props} type="button" class={VALUE_TRIGGER} aria-label={label}>
        <span class="min-w-0 truncate">{current}</span>
        <CaretDownIcon size={11} class="shrink-0 opacity-60" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class={menuClass}>
    <DropdownMenu.RadioGroup {value}>
      {#each options as opt (opt.value)}
        <DropdownMenu.RadioItem value={opt.value} onSelect={() => onSelect(opt.value)}>
          <span class="min-w-0 flex-1 truncate">{opt.label}</span>
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
