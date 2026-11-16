<script lang="ts">
  import HostStateIcon from "./HostStateIcon.svelte";
  import { needsAttention, rollup, type FleetMachine } from "./lib/fleet-model";

  /** The four numbers above the map (docs/plans/host-fleet.md D4): who answers,
   *  what runs, how hard the machines work, and what wants the person. */
  interface Props {
    machines: FleetMachine[];
  }

  let { machines }: Props = $props();

  const summary = $derived(rollup(machines));
  const busyHosts = $derived(machines.filter((machine) => machine.sessions > 0).length);
  const attention = $derived(machines.filter(needsAttention));
  const updates = $derived(attention.filter((machine) => machine.hasUpdate).length);
  const signIns = $derived(attention.filter((machine) => machine.needsSetup).length);
  const segments = $derived(
    [
      { count: summary.answering, color: "var(--success)", label: "online" },
      { count: summary.reconnecting, color: "var(--warning)", label: "reconnecting" },
      { count: summary.unreachable, color: "var(--solus-status-error)", label: "unreachable" },
      { count: summary.stopped, color: "var(--hairline-strong)", label: "stopped" },
    ].filter((segment) => segment.count > 0),
  );
</script>

<!-- Hairlines between the cells, reset for the column count: 2 across, then 4. -->
<div class="@container">
  <dl class="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_-6px_rgb(0_0_0/0.08)] dark:bg-card dark:shadow-none @[40rem]:grid-cols-4">
    <div class="flex min-w-0 flex-col gap-2 border-border/40 px-4 py-3.5 [&:nth-child(2n)]:border-l [&:nth-child(n+3)]:border-t @[40rem]:[&:nth-child(n+2)]:border-l @[40rem]:[&:nth-child(n+3)]:border-t-0">
      <dt class="truncate text-chrome-dense text-muted-foreground">Online</dt>
      <dd class="flex flex-col gap-2">
        <p class="text-[1.375rem] font-medium tracking-[-0.01em] tabular-nums">
          {summary.answering}<span class="text-muted-foreground"> / {summary.total}</span>
        </p>
        <div class="flex h-5 items-center">
          <div class="flex h-1 w-full gap-0.5 overflow-hidden rounded-full bg-(--wash-3)">
            {#each segments as segment (segment.label)}
              <span
                title="{segment.count} {segment.label}"
                class="h-full min-w-[3px] rounded-full transition-[width] duration-700 motion-reduce:transition-none"
                style:width="{(segment.count / Math.max(summary.total, 1)) * 100}%"
                style:background={segment.color}
              ></span>
            {/each}
          </div>
        </div>
      </dd>
    </div>
    <div class="flex min-w-0 flex-col gap-2 border-border/40 px-4 py-3.5 [&:nth-child(2n)]:border-l [&:nth-child(n+3)]:border-t @[40rem]:[&:nth-child(n+2)]:border-l @[40rem]:[&:nth-child(n+3)]:border-t-0">
      <dt class="truncate text-chrome-dense text-muted-foreground">Sessions on {busyHosts} {busyHosts === 1 ? "host" : "hosts"}</dt>
      <dd class="flex flex-col gap-2">
        <p class="text-[1.375rem] font-medium tracking-[-0.01em] tabular-nums">{summary.sessions}</p>
        <div class="flex h-5 items-center">
          <div class="h-1 w-full overflow-hidden rounded-full bg-(--wash-3)">
            <div
              class="h-full rounded-full bg-(--solus-status-running) transition-[width] duration-700 motion-reduce:transition-none"
              style:width="{(busyHosts / Math.max(summary.answering, 1)) * 100}%"
            ></div>
          </div>
        </div>
      </dd>
    </div>
    <div class="flex min-w-0 flex-col gap-2 border-border/40 px-4 py-3.5 [&:nth-child(2n)]:border-l [&:nth-child(n+3)]:border-t @[40rem]:[&:nth-child(n+2)]:border-l @[40rem]:[&:nth-child(n+3)]:border-t-0">
      <dt class="truncate text-chrome-dense text-muted-foreground">Average CPU</dt>
      <dd class="flex flex-col gap-2">
        <p class="text-[1.375rem] font-medium tracking-[-0.01em] tabular-nums">
          {summary.averageCpu === null ? "—" : `${summary.averageCpu}%`}
        </p>
        <div class="flex h-5 items-center">
          <div class="h-1 w-full overflow-hidden rounded-full bg-(--wash-3)">
            <div
              class="h-full rounded-full transition-[width] duration-1000 ease-out motion-reduce:transition-none"
              style:width="{summary.averageCpu ?? 0}%"
              style:background={(summary.averageCpu ?? 0) >= 80 ? "var(--warning)" : "var(--success)"}
            ></div>
          </div>
        </div>
      </dd>
    </div>
    <div class="flex min-w-0 flex-col gap-2 border-border/40 px-4 py-3.5 [&:nth-child(2n)]:border-l [&:nth-child(n+3)]:border-t @[40rem]:[&:nth-child(n+2)]:border-l @[40rem]:[&:nth-child(n+3)]:border-t-0">
      <dt class="truncate text-chrome-dense text-muted-foreground">Needs attention</dt>
      <dd class="flex flex-col gap-2">
        <p class="text-[1.375rem] font-medium tracking-[-0.01em] tabular-nums {attention.length ? 'text-(--solus-status-running)' : ''}">
          {attention.length}
        </p>
        <p class="flex h-5 items-center gap-2.5">
          {#if attention.length === 0}
            <HostStateIcon state="online" />
          {:else}
            {#if summary.unreachable}<HostStateIcon state="unreachable" count={summary.unreachable} />{/if}
            {#if summary.reconnecting}<HostStateIcon state="reconnecting" count={summary.reconnecting} />{/if}
            {#if signIns}<HostStateIcon state="signin" count={signIns} />{/if}
            {#if updates}<HostStateIcon state="update" count={updates} />{/if}
          {/if}
        </p>
      </dd>
    </div>
  </dl>
</div>
