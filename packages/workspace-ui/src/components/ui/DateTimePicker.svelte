<script lang="ts">
  import { getLocalTimeZone, parseDate } from "@internationalized/date";
  import { CalendarBlankIcon, CaretDownIcon } from "phosphor-svelte";
  import { cn } from "@solus/workspace-ui/lib/utils.js";
  import { Button } from "./button";
  import { Calendar } from "./calendar";
  import * as Popover from "./popover";
  import { Separator } from "./separator";
  import { TimeField } from "./time-field";

  // Reusable date + time picker. Value is a local "YYYY-MM-DDTHH:MM" string
  // (the datetime-local format); emits the same on any change.
  //
  // shadcn-svelte has no date-picker to install: it documents a composition of
  // Popover + Calendar + a Button trigger, which is what this is. Two departures
  // from that recipe, both deliberate. The halves share one border and one focus
  // ring, split by an inset rule, because they carry one value — the control
  // says "an instant", not "two settings that happen to sit together". And the
  // time half is our segmented TimeField rather than the recipe's
  // `<input type="time">`, whose inner chrome the browser draws and no class of
  // ours can reach.
  interface Props {
    value: string;
    onChange: (value: string) => void;
    class?: string;
  }

  let { value, onChange, class: className }: Props = $props();
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
  const dateLabel = $derived(
    calValue
      ? calValue.toDate(getLocalTimeZone()).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "Select date",
  );
</script>

<div
  class={cn(
    "border-input focus-within:border-ring focus-within:ring-ring/50 inline-flex h-8 w-fit min-w-[min(14rem,100%)] items-center rounded-lg border bg-transparent text-sm transition-colors focus-within:ring-3 pointer-coarse:h-10",
    className,
  )}
>
  <Popover.Root bind:open>
    <Popover.Trigger id={`${id}-date`}>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          aria-label="Date"
          class="h-full min-w-0 flex-1 cursor-pointer justify-start gap-1.5 rounded-l-lg rounded-r-none px-2 text-[length:inherit] font-normal focus-visible:border-transparent focus-visible:bg-(--solus-accent-light) focus-visible:ring-0"
        >
          <CalendarBlankIcon class="size-3.5 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate text-left" class:text-muted-foreground={!calValue}>
            {dateLabel}
          </span>
          <CaretDownIcon weight="bold" class="size-2.5 text-muted-foreground" />
        </Button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content
      side="top"
      align="start"
      class="z-[10002] w-auto gap-0 overflow-hidden rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-0 shadow-[shadow:var(--solus-popover-shadow)] ring-0 backdrop-blur-xl"
    >
      <!-- The stock calendar is sized for a page form, not for a popover hung
           off a 28px field. `--cell-size` is only half of it: the head cells,
           the day cells and the month/year chips each hardcode their own
           `text-sm`, so a font-size on the root never reaches them and the grid
           stays page-scale however small the cells get. These are the smallest
           set of call-site overrides that scale the whole thing — the stock
           files stay untouched. Horizontal padding runs wider than vertical:
           shrinking a calendar to fit makes it read as cramped long before it
           reads as small. On a coarse pointer the cells grow back to a 36px
           tap target and the day numbers step back up. -->
      <Calendar
        type="single"
        value={calValue}
        onValueChange={(date) => {
          if (!date) return;
          onChange(`${date.toString()}T${timePart}`);
          open = false;
        }}
        captionLayout="dropdown"
        class="px-2.5 py-1.5 [--cell-size:1.625rem] [&_td]:text-xs [&_th]:text-xs [&_select+span]:gap-0.5 [&_select+span]:ps-1.5 [&_select+span]:pe-0.5 [&_select+span]:text-xs [&_select+span>svg]:size-3 pointer-coarse:[--cell-size:2.25rem] pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:[&_td]:text-xs pointer-coarse:[&_th]:text-xs pointer-coarse:[&_select+span]:text-xs"
      />
    </Popover.Content>
  </Popover.Root>

  <!-- The stock vertical rule is full-height; inside the shell it reads as a
       seam between two fields rather than one control, so it is inset. A
       variant-prefixed class is its own merge group, so the override has to
       restate the orientation selector to displace it. -->
  <Separator orientation="vertical" class="data-[orientation=vertical]:h-4" />

  <TimeField
    id={`${id}-time`}
    value={timePart}
    onChange={(next) => onChange(`${datePart}T${next}`)}
    class="h-full rounded-l-none rounded-r-lg border-0 px-1.5 text-[length:inherit] transition-colors hover:bg-muted focus-within:border-transparent focus-within:ring-0 pointer-coarse:h-full"
  />
</div>
