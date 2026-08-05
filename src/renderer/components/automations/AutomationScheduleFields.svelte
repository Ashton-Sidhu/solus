<script lang="ts">
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import DateTimePicker from "../ui/DateTimePicker.svelte";
  import { WEEKDAYS, type BuilderTriggerKind } from "./lib/automation-format";
  import type { ScheduleDraft } from "./lib/schedule-draft.svelte";
  import AutomationRailSelect from "./AutomationRailSelect.svelte";
  import { ROW, EYEBROW, RAIL_FIELD } from "./lib/rail-styles";

  // The rail's Schedule block: whether the automation is live, how often it
  // repeats, and the one or two fields that preset needs. Every change commits
  // immediately — there is no Save.
  interface Props {
    schedule: ScheduleDraft;
    enabled: boolean;
    onEnabledChange: (next: boolean) => void;
    onCommit: () => void;
  }
  let { schedule, enabled, onEnabledChange, onCommit }: Props = $props();

  const repeatOptions: { value: BuilderTriggerKind; label: string }[] = [
    { value: "manual", label: "Manual" },
    { value: "interval", label: "On an interval" },
    { value: "daily", label: "Daily" },
    { value: "weekly", label: "Weekly" },
    { value: "monthly", label: "Monthly" },
    { value: "once", label: "Once" },
    { value: "cron", label: "Custom (cron)" },
  ];
  const intervalUnitOptions = [
    { value: "minutes" as const, label: "minutes" },
    { value: "hours" as const, label: "hours" },
    { value: "days" as const, label: "days" },
  ];
  // Weekday values are numbers on the trigger but strings in the menu, which
  // keys and compares its options as strings.
  const weekdayOptions = WEEKDAYS.map((d) => ({
    value: String(d.value),
    label: d.label,
  }));

  // Daily, weekly and monthly all land on a clock time; only their extra field
  // differs, so the "At" row is rendered once below them.
  const hasTimeOfDay = $derived(
    schedule.kind === "daily" ||
      schedule.kind === "weekly" ||
      schedule.kind === "monthly",
  );
</script>

<span class={EYEBROW}>Schedule</span>
<div class="flex flex-col">
  <div class={ROW}>
    <span class="text-muted-foreground">Enabled</span>
    <!-- Sage owns status: this switch says "running on schedule". The Worktree
         switch in Setup is a plain setting and keeps the brand terracotta. -->
    <Switch
      checked={enabled}
      onCheckedChange={onEnabledChange}
      size="default"
      class="data-checked:bg-chart-3"
      aria-label={enabled ? "Pause automation" : "Resume automation"}
    />
  </div>

  <div class={ROW}>
    <span class="text-muted-foreground">Repeats</span>
    <AutomationRailSelect
      label="Repeats"
      value={schedule.kind}
      options={repeatOptions}
      onSelect={(v) => {
        schedule.kind = v;
        onCommit();
      }}
    />
  </div>

  {#if schedule.kind === "interval"}
    <div class={ROW}>
      <span class="text-muted-foreground">Every</span>
      <span class="flex items-center gap-1">
        <Input
          class="{RAIL_FIELD} mr-0 w-14"
          type="number"
          min="1"
          bind:value={schedule.intervalValue}
          onchange={onCommit}
          aria-label="Interval amount"
        />
        <AutomationRailSelect
          label="Interval unit"
          value={schedule.intervalUnit}
          options={intervalUnitOptions}
          onSelect={(v) => {
            schedule.intervalUnit = v;
            onCommit();
          }}
          menuClass="w-[140px]"
        />
      </span>
    </div>
  {:else if schedule.kind === "weekly"}
    <div class={ROW}>
      <span class="text-muted-foreground">On</span>
      <AutomationRailSelect
        label="Day of week"
        value={String(schedule.weekday)}
        options={weekdayOptions}
        onSelect={(v) => {
          schedule.weekday = Number(v);
          onCommit();
        }}
      />
    </div>
  {:else if schedule.kind === "monthly"}
    <div class={ROW}>
      <span class="text-muted-foreground">Day</span>
      <Input
        class="{RAIL_FIELD} w-14"
        type="number"
        min="1"
        max="31"
        bind:value={schedule.monthDay}
        onchange={onCommit}
        aria-label="Day of month"
      />
    </div>
  {:else if schedule.kind === "cron"}
    <div class={ROW}>
      <span class="text-muted-foreground">Expression</span>
      <Input
        class="{RAIL_FIELD} w-32"
        type="text"
        dictation={false}
        bind:value={schedule.cronExpr}
        onchange={onCommit}
        placeholder="0 9 * * 1-5"
        aria-label="Cron expression"
        aria-invalid={schedule.cronInvalid}
        autocomplete="off"
      />
    </div>
    {#if schedule.cronInvalid}
      <p class="m-0 text-right text-[12px] text-[var(--solus-status-error,#e53e3e)]">
        Invalid cron expression.
      </p>
    {/if}
  {:else if schedule.kind === "once"}
    <div class="flex justify-end py-1">
      <DateTimePicker
        value={schedule.onceLocal}
        onChange={(v) => {
          schedule.onceLocal = v;
          onCommit();
        }}
      />
    </div>
  {/if}

  {#if hasTimeOfDay}
    <div class={ROW}>
      <span class="text-muted-foreground">At</span>
      <Input
        type="time"
        value={schedule.time}
        onchange={(event) => {
          const value = event.currentTarget.value;
          if (!value) return;
          schedule.time = value;
          onCommit();
        }}
        class="{RAIL_FIELD} w-24"
        aria-label="Time"
      />
    </div>
  {/if}
</div>
