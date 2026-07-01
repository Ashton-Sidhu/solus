<script lang="ts">
  import Select from "./Select.svelte";

  // Select-based time-of-day picker (hour · minute · AM/PM) that matches the
  // app's ghost dropdowns, replacing the native time input. Operates on a 24h
  // hh/mm pair; the parent owns formatting/persistence.
  interface Props {
    hh: number;
    mm: number;
    onChange: (hh: number, mm: number) => void;
    align?: "bottom" | "top";
  }
  let { hh, mm, onChange, align = "bottom" }: Props = $props();

  const hour12 = $derived(hh % 12 || 12);
  const period = $derived(hh >= 12 ? "PM" : "AM");

  const hourOptions = Array.from({ length: 12 }, (_, i) => ({
    value: i + 1,
    label: String(i + 1),
  }));
  const periodOptions = [
    { value: "AM", label: "AM" },
    { value: "PM", label: "PM" },
  ];
  // 5-minute steps, but always surface the current minute so an odd saved value
  // (e.g. :07 from a hand-edited cron) still shows instead of falling blank.
  const minuteOptions = $derived.by(() => {
    const mins = new Set<number>();
    for (let m = 0; m < 60; m += 5) mins.add(m);
    mins.add(mm);
    return [...mins]
      .sort((a, b) => a - b)
      .map((m) => ({ value: m, label: String(m).padStart(2, "0") }));
  });

  function emit(h12: number, minute: number, per: string) {
    const h = (h12 % 12) + (per === "PM" ? 12 : 0);
    onChange(h, minute);
  }
</script>

<div class="inline-flex items-center gap-0.5">
  <Select
    value={hour12}
    options={hourOptions}
    onChange={(v) => emit(v, mm, period)}
    ariaLabel="Hour"
    {align}
    anchor="right"
    variant="ghost"
  />
  <span class="text-xs text-(--solus-text-tertiary)">:</span>
  <Select
    value={mm}
    options={minuteOptions}
    onChange={(v) => emit(hour12, v, period)}
    ariaLabel="Minute"
    {align}
    anchor="right"
    variant="ghost"
  />
  <Select
    value={period}
    options={periodOptions}
    onChange={(v) => emit(hour12, mm, v)}
    ariaLabel="AM/PM"
    {align}
    anchor="right"
    variant="ghost"
  />
</div>
