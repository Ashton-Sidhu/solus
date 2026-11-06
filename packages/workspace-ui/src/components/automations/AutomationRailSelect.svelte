<script lang="ts" generics="T extends string">
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { LABEL, ROW_BUTTON, VALUE } from "./lib/rail-styles";

  /** An editable row in the detail view's rail.
   *
   *  Same language as the model picker: the whole row is the target, the label
   *  sits quiet opposite its value, a caret marks it editable, and a radio menu
   *  opens on the shared menu surface. Selection commits immediately, so this
   *  emits `onSelect` rather than binding a value. */
  interface Props {
    /** The row's visible label and the heading of its menu. */
    label: string;
    value: T;
    options: { value: T; label: string; disabled?: boolean }[];
    onSelect: (value: T) => void;
    /** Menu width. Long label sets (models, agents) need more room than the
     *  default; the caller knows which. */
    menuClass?: string;
    /** Shown when the value matches no option. */
    placeholder?: string;
  }
  let { label, value, options, onSelect, menuClass = "w-[176px]", placeholder = "" }: Props = $props();

  let open = $state(false);
  const current = $derived(options.find((o) => o.value === value)?.label ?? placeholder);
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button {...props} type="button" class={ROW_BUTTON}>
        <span class={LABEL}>{label}</span>
        <span class="ml-auto {VALUE}">{current}</span>
        <CaretDownIcon size={12} strokeWidth={1.5} class="shrink-0 text-(--solus-text-tertiary) transition-transform duration-150 {open ? 'rotate-180' : ''}" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class={menuClass}>
    <DropdownMenu.RadioGroup {value}>
      <DropdownMenu.GroupHeading>{label}</DropdownMenu.GroupHeading>
      {#each options as opt (opt.value)}
        <DropdownMenu.RadioItem value={opt.value} disabled={opt.disabled} onSelect={() => onSelect(opt.value)}>
          <span class="min-w-0 flex-1 truncate">{opt.label}</span>
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
