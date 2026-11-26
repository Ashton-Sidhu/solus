<script lang="ts">
  import { diskFreeText, diskUsedPercent, formatResourceBytes } from "@solus/client-core/host-resource-watch";
  import { Sparkline } from "../ui/sparkline";
  import HostStateIcon from "./HostStateIcon.svelte";
  import type { HostLoad } from "./fleet.store.svelte";
  import { routeHops, type FleetMachine } from "./lib/fleet-model";

  /** A host's five numbers, the same for every host: CPU, memory, disk, sessions, and latency.
   *  Each cell is a label, a value, and one 20px line below it, so the cells align. */
  interface Props {
    machine: FleetMachine;
    load: HostLoad | undefined;
  }

  let { machine, load }: Props = $props();

  const isAnswering = $derived(machine.state === "running" || machine.state === "idle");
  const memoryGb = $derived(load?.totalMemoryBytes ? Math.round(load.totalMemoryBytes / 1024 ** 3) : null);
  const disk = $derived(load?.disk ?? null);
  const diskUsed = $derived(disk ? diskUsedPercent(disk) : null);
</script>

<div class="@container">
  <dl class="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_-6px_rgb(0_0_0/0.08)] dark:bg-card dark:shadow-none @[40rem]:grid-cols-5">
    <div class="flex min-w-0 flex-col gap-2 border-border/40 px-4 py-3.5 [&:nth-child(2n)]:border-l [&:nth-child(n+3)]:border-t @[40rem]:[&:nth-child(n+2)]:border-l @[40rem]:[&:nth-child(n+3)]:border-t-0">
      <dt class="truncate text-chrome-dense text-muted-foreground">CPU{load?.cpuCount ? ` · ${load.cpuCount} cores` : ""}</dt>
      <dd class="flex flex-col gap-2">
        <p class="text-[1.375rem] font-medium tracking-[-0.01em] tabular-nums">{machine.cpu === null ? "—" : `${machine.cpu}%`}</p>
        <Sparkline values={isAnswering ? (load?.cpuHistory ?? []) : []} class="h-5 w-full" />
      </dd>
    </div>
    <div class="flex min-w-0 flex-col gap-2 border-border/40 px-4 py-3.5 [&:nth-child(2n)]:border-l [&:nth-child(n+3)]:border-t @[40rem]:[&:nth-child(n+2)]:border-l @[40rem]:[&:nth-child(n+3)]:border-t-0">
      <dt class="truncate text-chrome-dense text-muted-foreground">Memory{memoryGb ? ` · ${memoryGb} GB` : ""}</dt>
      <dd class="flex flex-col gap-2">
        <p class="text-[1.375rem] font-medium tracking-[-0.01em] tabular-nums">{machine.memory === null ? "—" : `${machine.memory}%`}</p>
        <div class="flex h-5 items-center">
          <div class="h-1 w-full overflow-hidden rounded-full bg-(--wash-3)">
            <div class="h-full rounded-full transition-[width] duration-1000 ease-out motion-reduce:transition-none"
              style:width="{machine.memory ?? 0}%" style:background={(machine.memory ?? 0) >= 85 ? "var(--warning)" : "var(--success)"}></div>
          </div>
        </div>
      </dd>
    </div>
    <div class="flex min-w-0 flex-col gap-2 border-border/40 px-4 py-3.5 [&:nth-child(2n)]:border-l [&:nth-child(n+3)]:border-t @[40rem]:[&:nth-child(n+2)]:border-l @[40rem]:[&:nth-child(n+3)]:border-t-0">
      <dt class="truncate text-chrome-dense text-muted-foreground" title="The disk that holds the Solus data folder">Disk{disk ? ` · ${formatResourceBytes(disk.totalBytes)}` : ""}</dt>
      <dd class="flex flex-col gap-2">
        <p class="truncate text-[1.375rem] font-medium tracking-[-0.01em] tabular-nums">{disk ? diskFreeText(disk) : "—"}</p>
        <div class="flex h-5 items-center">
          <div class="h-1 w-full overflow-hidden rounded-full bg-(--wash-3)">
            <div class="h-full rounded-full transition-[width] duration-1000 ease-out motion-reduce:transition-none"
              style:width="{diskUsed ?? 0}%" style:background={(diskUsed ?? 0) >= 90 ? "var(--warning)" : "var(--success)"}></div>
          </div>
        </div>
      </dd>
    </div>
    <div class="flex min-w-0 flex-col gap-2 border-border/40 px-4 py-3.5 [&:nth-child(2n)]:border-l [&:nth-child(n+3)]:border-t @[40rem]:[&:nth-child(n+2)]:border-l @[40rem]:[&:nth-child(n+3)]:border-t-0">
      <dt class="truncate text-chrome-dense text-muted-foreground">Sessions</dt>
      <dd class="flex flex-col gap-2">
        <p class="text-[1.375rem] font-medium tracking-[-0.01em] tabular-nums">{machine.sessions}</p>
        <p class="flex h-5 items-center"><HostStateIcon state={machine.state} /></p>
      </dd>
    </div>
    <div class="flex min-w-0 flex-col gap-2 border-border/40 px-4 py-3.5 [&:nth-child(2n)]:border-l [&:nth-child(n+3)]:border-t @[40rem]:[&:nth-child(n+2)]:border-l @[40rem]:[&:nth-child(n+3)]:border-t-0">
      <dt class="truncate text-chrome-dense text-muted-foreground">Latency</dt>
      <dd class="flex flex-col gap-2">
        <p class="text-[1.375rem] font-medium tracking-[-0.01em] tabular-nums">{machine.latencyMs === null ? "—" : `${machine.latencyMs} ms`}</p>
        <p class="flex h-5 items-center text-chrome-dense text-muted-foreground"><span class="truncate">{routeHops(machine)[1] ?? "On this device"}</span></p>
      </dd>
    </div>
  </dl>
</div>
