<script lang="ts">
  import { ArrowUpRight, Bot, CircleArrowUp, Plus, Power, RefreshCw, Trash2 } from "@lucide/svelte";
  import * as ContextMenu from "../ui/context-menu";
  import type { FleetMachine } from "./lib/fleet-model";

  /**
   * What a person can do with one host from the map (docs/plans/host-fleet.md
   * D12): ask an agent about it, open it, start a session on it, and the one
   * fix its state has. A card on the map keeps one job, which is to open the host.
   */
  interface Props {
    x: number;
    y: number;
    machine: FleetMachine;
    onAsk: () => void;
    onOpen: () => void;
    onNewSession: () => void;
    onRetry: () => void;
    onStart: () => void;
    onUpdate: () => void;
    onRemove: () => void;
    onClose: () => void;
  }

  let { x, y, machine, onAsk, onOpen, onNewSession, onRetry, onStart, onUpdate, onRemove, onClose }: Props = $props();

  const answers = $derived(machine.state === "running" || machine.state === "idle");
  const canRetry = $derived(machine.state === "unreachable");
  const canStart = $derived(machine.state === "stopped" && machine.hasManagedCompute);

  function select(action: () => void): void {
    action();
    onClose();
  }
</script>

<ContextMenu.Root
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-44">
    <ContextMenu.Item onSelect={() => select(onAsk)}>
      <Bot />
      Ask an agent
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={() => select(onOpen)}>
      <ArrowUpRight />
      Open host
    </ContextMenu.Item>
    <ContextMenu.Item disabled={!answers} onSelect={() => select(onNewSession)}>
      <Plus />
      New session
    </ContextMenu.Item>
    {#if canRetry || canStart || machine.hasUpdate}
      <ContextMenu.Separator />
      {#if canRetry}
        <ContextMenu.Item onSelect={() => select(onRetry)}>
          <RefreshCw />
          Retry
        </ContextMenu.Item>
      {/if}
      {#if canStart}
        <ContextMenu.Item onSelect={() => select(onStart)}>
          <Power />
          Start
        </ContextMenu.Item>
      {/if}
      {#if machine.hasUpdate}
        <ContextMenu.Item onSelect={() => select(onUpdate)}>
          <CircleArrowUp />
          Update
        </ContextMenu.Item>
      {/if}
    {/if}
    {#if !machine.isThisDevice && !machine.isCloud}
      <ContextMenu.Separator />
      <ContextMenu.Item variant="destructive" onSelect={() => select(onRemove)}>
        <Trash2 />
        Remove
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
