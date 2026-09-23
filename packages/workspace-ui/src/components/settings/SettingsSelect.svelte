<script lang="ts" generics="T extends string">
  /** A settings row's single-choice control: the current value on a quiet
   *  bordered trigger, the choices in a radio menu beneath it. One shape for
   *  every pick-one setting, so a row with three options and a row with eight
   *  read as the same control. The trigger is deliberately lighter than the
   *  outline button — normal weight, a whisper of shadow, a muted chevron — so
   *  it sits in the row rather than standing out from it. */
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import { requestInputFocus } from "../../lib/inputFocus";

  let {
    options,
    value,
    onSelect,
    ariaLabel,
    disabled = false,
    compact = false,
  }: {
    options: ReadonlyArray<{ value: T; label: string }>;
    value: T;
    onSelect: (value: T) => void;
    ariaLabel: string;
    disabled?: boolean;
    /** Toolbar size: fits its label instead of the settings column width. */
    compact?: boolean;
  } = $props();

  const selectedLabel = $derived(
    options.find((option) => option.value === value)?.label ?? "",
  );
</script>

<DropdownMenu.Root
  onOpenChange={(next) => {
    if (!next) requestInputFocus();
  }}
>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="outline"
        size={compact ? "xs" : "sm"}
        aria-label={ariaLabel}
        class="{compact ? 'text-xs' : 'min-w-36 text-sm'} justify-between gap-1.5 border-input bg-background font-normal text-foreground shadow-xs/5 hover:bg-background hover:text-foreground aria-expanded:bg-background dark:bg-input/30 dark:hover:bg-input/30"
        {disabled}
      >
        <span class="truncate">{selectedLabel}</span>
        <CaretDownIcon size={14} class="-me-1 shrink-0 text-muted-foreground opacity-80" />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="bottom" align="end" sideOffset={6}>
    <DropdownMenu.RadioGroup {value}>
      {#each options as option (option.value)}
        <DropdownMenu.RadioItem
          value={option.value}
          onSelect={() => onSelect(option.value)}
        >
          <span class="truncate">{option.label}</span>
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
