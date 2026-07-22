<script lang="ts">
  import { getLocalTimeZone, parseDate } from "@internationalized/date";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import { Button } from "./button";
  import { Calendar } from "./calendar";
  import { Input } from "./input";
  import { Label } from "./label";
  import * as Popover from "./popover";

  // Reusable date + time picker. Value is a local "YYYY-MM-DDTHH:MM" string
  // (the datetime-local format); emits the same on any change.
  interface Props {
    value: string;
    onChange: (value: string) => void;
  }

  let { value, onChange }: Props = $props();
  const id = $props.id();
  let open = $state(false);

  const datePart = $derived(value.split("T")[0] || "");
  const timePart = $derived(value.split("T")[1] || "09:00");
  const calValue = $derived.by(() => {
    try {
      return parseDate(datePart);
    } catch {
      return undefined;
    }
  });

  function setDate(date: string) {
    onChange(`${date}T${timePart}`);
  }

  function setTime(event: Event) {
    const next = (event.currentTarget as HTMLInputElement).value;
    if (next) onChange(`${datePart}T${next}`);
  }
</script>

<div class="inline-flex flex-wrap items-end gap-1.5">
  <div class="flex flex-col gap-1">
    <Label
      for={`${id}-date`}
      class="px-0.5 text-[0.625rem] font-medium text-(--solus-text-tertiary)"
    >Date</Label>
    <Popover.Root bind:open>
      <Popover.Trigger id={`${id}-date`}>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="outline"
            class="sel-ghost h-6 w-28 justify-between rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[0.6875rem] font-normal text-(--solus-text-primary) shadow-none transition-[background-color,color,outline-color,transform] duration-120 hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:border-transparent focus-visible:bg-(--solus-accent-light) focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] pointer-coarse:h-10 pointer-coarse:rounded-lg pointer-coarse:px-2 pointer-coarse:text-xs"
          >
            <span class="truncate">
              {calValue
                ? calValue.toDate(getLocalTimeZone()).toLocaleDateString()
                : "Select date"}
            </span>
            <ChevronDownIcon class="size-3 shrink-0" />
          </Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content
        side="top"
        align="start"
        class="z-[10002] w-auto overflow-hidden rounded-xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-0 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl"
      >
        <Calendar
          type="single"
          value={calValue}
          onValueChange={(date) => {
            if (!date) return;
            setDate(date.toString());
            open = false;
          }}
          captionLayout="dropdown"
          class="p-1.5 text-[0.6875rem] [--cell-size:1.625rem]"
        />
      </Popover.Content>
    </Popover.Root>
  </div>

  <div class="flex flex-col gap-1">
    <Label
      for={`${id}-time`}
      class="px-0.5 text-[0.625rem] font-medium text-(--solus-text-tertiary)"
    >Time</Label>
    <Input
      type="time"
      id={`${id}-time`}
      step="60"
      value={timePart}
      onchange={setTime}
      class="sel-ghost scheme-light dark:scheme-dark h-6 w-[4.75rem] min-w-0 appearance-none rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[0.6875rem] tabular-nums text-(--solus-text-primary) transition-[background-color,outline-color] duration-120 hover:bg-(--solus-surface-hover) focus-visible:border-transparent focus-visible:bg-(--solus-accent-light) focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] pointer-coarse:h-10 pointer-coarse:w-24 pointer-coarse:rounded-lg pointer-coarse:px-2 pointer-coarse:text-xs [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none [&::-webkit-datetime-edit]:p-0"
    />
  </div>
</div>
