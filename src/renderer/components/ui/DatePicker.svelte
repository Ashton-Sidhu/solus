<script lang="ts">
  import { CalendarBlankIcon, CaretLeftIcon, CaretRightIcon } from "phosphor-svelte";
  import Dropdown from "./Dropdown.svelte";

  // Branded calendar popover that replaces the native date input. Value is a
  // local "YYYY-MM-DD" string; the parent owns persistence.
  interface Props {
    value: string;
    onChange: (value: string) => void;
    ariaLabel?: string;
    placeholder?: string;
    anchor?: "left" | "right";
  }
  let {
    value,
    onChange,
    ariaLabel = "Date",
    placeholder = "Pick a date",
    anchor = "left",
  }: Props = $props();

  const pad = (n: number) => String(n).padStart(2, "0");
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  function parse(s: string) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
    return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
  }
  const key = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

  const now = new Date();
  const todayKey = key(now.getFullYear(), now.getMonth(), now.getDate());
  const selectedKey = $derived(value && parse(value) ? value : null);

  const label = $derived.by(() => {
    const s = parse(value);
    return s
      ? new Date(s.y, s.m, s.d).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : placeholder;
  });

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  // The month currently on screen (drives the grid + header).
  let viewY = $state(now.getFullYear());
  let viewM = $state(now.getMonth());

  function toggle() {
    if (!open) {
      const s = parse(value);
      viewY = s ? s.y : now.getFullYear();
      viewM = s ? s.m : now.getMonth();
    }
    open = !open;
  }
  function prevMonth() {
    if (viewM === 0) { viewM = 11; viewY -= 1; } else viewM -= 1;
  }
  function nextMonth() {
    if (viewM === 11) { viewM = 0; viewY += 1; } else viewM += 1;
  }
  function pick(c: { y: number; m: number; d: number }) {
    onChange(key(c.y, c.m, c.d));
    open = false;
  }

  // 6×7 grid spanning the view month, padded with neighbouring-month days.
  const cells = $derived.by(() => {
    const startDow = new Date(viewY, viewM, 1).getDay();
    const start = new Date(viewY, viewM, 1 - startDow);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return {
        y: d.getFullYear(),
        m: d.getMonth(),
        d: d.getDate(),
        k: key(d.getFullYear(), d.getMonth(), d.getDate()),
        inMonth: d.getMonth() === viewM,
      };
    });
  });

  const NAV_BTN =
    "inline-flex items-center justify-center w-6 h-6 rounded-md text-(--solus-text-tertiary) " +
    "transition-colors duration-100 hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) " +
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]";

  function dayClass(c: { k: string; inMonth: boolean }) {
    const base =
      "inline-flex items-center justify-center h-7 rounded-md text-xs transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] ";
    if (c.k === selectedKey)
      return base + "bg-(--solus-accent) text-[var(--solus-accent-contrast,#fff)] font-semibold";
    const tone = c.inMonth
      ? "text-(--solus-text-primary)"
      : "text-[color-mix(in_srgb,var(--solus-text-tertiary)_55%,transparent)]";
    const today = c.k === todayKey ? " font-semibold text-(--solus-accent)" : "";
    return base + tone + today + " hover:bg-(--solus-accent-light)";
  }
</script>

<button
  bind:this={triggerEl}
  type="button"
  aria-label={ariaLabel}
  aria-haspopup="dialog"
  aria-expanded={open}
  onclick={toggle}
  class="inline-flex items-center gap-1.5 max-w-[11rem] px-1.5 py-1 text-xs rounded-lg border-0 bg-transparent cursor-pointer transition-colors duration-100 hover:bg-(--solus-accent-light) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] {selectedKey
    ? 'text-(--solus-text-primary)'
    : 'text-(--solus-text-tertiary)'}"
>
  <CalendarBlankIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
  <span class="truncate">{label}</span>
</button>

<Dropdown bind:open {triggerEl} {anchor} align="top" width={252}>
  <div class="p-2">
    <!-- Month nav -->
    <div class="flex items-center justify-between mb-1.5">
      <button type="button" class={NAV_BTN} onclick={prevMonth} aria-label="Previous month">
        <CaretLeftIcon size={13} weight="bold" />
      </button>
      <span class="text-xs font-semibold text-(--solus-text-primary)">{MONTHS[viewM]} {viewY}</span>
      <button type="button" class={NAV_BTN} onclick={nextMonth} aria-label="Next month">
        <CaretRightIcon size={13} weight="bold" />
      </button>
    </div>
    <!-- Weekday header -->
    <div class="grid grid-cols-7 mb-0.5">
      {#each WEEKDAYS as w (w)}
        <span class="inline-flex items-center justify-center h-6 text-[0.625rem] font-medium uppercase tracking-wide text-(--solus-text-tertiary)">{w}</span>
      {/each}
    </div>
    <!-- Day grid -->
    <div class="grid grid-cols-7 gap-0.5">
      {#each cells as c (c.k)}
        <button type="button" class={dayClass(c)} onclick={() => pick(c)}>{c.d}</button>
      {/each}
    </div>
  </div>
</Dropdown>
