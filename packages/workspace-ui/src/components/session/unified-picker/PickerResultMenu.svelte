<script lang="ts">
  import { ChevronDown } from "@lucide/svelte";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { PICKER_RESULT_LABELS, type PickerResultType } from "./lib/picker-preferences";

  interface Props {
    value: PickerResultType;
    onChange: (value: PickerResultType) => void;
    portalTarget: HTMLElement | null;
    open?: boolean;
  }
  let { value, onChange, portalTarget, open = $bindable(false) }: Props = $props();
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-workspace-chrome text-muted-foreground shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] hover:bg-[var(--wash-2)] hover:text-foreground max-md:h-11"
        aria-label={`Result type: ${PICKER_RESULT_LABELS[value]}`}
        title="Result type (⌥T)"
      >
        <span>{PICKER_RESULT_LABELS[value]}</span>
        <ChevronDown class="size-3 shrink-0 opacity-50" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    side="bottom"
    align="end"
    sideOffset={6}
    class="w-max min-w-[max(12rem,var(--bits-dropdown-menu-anchor-width))] max-w-[calc(100vw-2rem)]"
    portalProps={{ to: portalTarget ?? undefined }}
  >
    <DropdownMenu.Group>
      <DropdownMenu.GroupHeading>Show</DropdownMenu.GroupHeading>
      <DropdownMenu.CheckboxItem
        checked={value !== "tasks"}
        disabled={value === "sessions"}
        closeOnSelect={false}
        onCheckedChange={(checked) => onChange(checked ? "all" : "tasks")}
        class="whitespace-nowrap text-workspace-chrome"
      >Sessions</DropdownMenu.CheckboxItem>
      <DropdownMenu.CheckboxItem
        checked={value !== "sessions"}
        disabled={value === "tasks"}
        closeOnSelect={false}
        onCheckedChange={(checked) => onChange(checked ? "all" : "sessions")}
        class="whitespace-nowrap text-workspace-chrome"
      >Tasks</DropdownMenu.CheckboxItem>
    </DropdownMenu.Group>
  </DropdownMenu.Content>
</DropdownMenu.Root>
