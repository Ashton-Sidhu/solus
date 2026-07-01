<script lang="ts">
  import DatePicker from "./DatePicker.svelte";
  import TimeFields from "./TimeFields.svelte";

  // Reusable date + time picker. Value is a local "YYYY-MM-DDTHH:MM" string
  // (the datetime-local format); emits the same on any change.
  interface Props {
    value: string;
    onChange: (value: string) => void;
    dateAnchor?: "left" | "right";
    timeAlign?: "bottom" | "top";
  }
  let { value, onChange, dateAnchor = "left", timeAlign = "bottom" }: Props =
    $props();

  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = $derived(value.split("T")[0] || "");
  const timePart = $derived(value.split("T")[1] || "09:00");
  const hh = $derived.by(() => {
    const h = Number(timePart.split(":")[0]);
    return Number.isFinite(h) ? h : 9;
  });
  const mm = $derived.by(() => {
    const m = Number(timePart.split(":")[1]);
    return Number.isFinite(m) ? m : 0;
  });

  function setDate(date: string) {
    onChange(`${date}T${timePart}`);
  }
  function setTime(h: number, m: number) {
    onChange(`${datePart}T${pad(h)}:${pad(m)}`);
  }
</script>

<div class="inline-flex items-center gap-1.5 flex-wrap">
  <DatePicker value={datePart} onChange={setDate} anchor={dateAnchor} />
  <TimeFields {hh} {mm} onChange={setTime} align={timeAlign} />
</div>
