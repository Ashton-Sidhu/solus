<script lang="ts">
  import { AppWindow, ArrowUpRight, Bot, CircleArrowUp, Copy, Link2, Plus, Power, RefreshCw, Trash2 } from "@lucide/svelte";
  import * as ContextMenu from "../ui/context-menu";
  import type { FleetMachine } from "./lib/fleet-model";

  /**
   * What a person can do with one host from the map: ask an agent about it, open
   * it, start a session on it, connect an outside app to it or copy its MCP
   * address (plans/035 §10), introduce it to another of your hosts, and the one
   * fix its state has. The menu key opens it on the focused host, so Introduce to
   * is the keyboard's way to do what a drag of the host's handle does.
   */
  interface Props {
    x: number;
    y: number;
    machine: FleetMachine;
    /** The hosts it can be introduced to now; none when this device cannot introduce it. */
    candidates: FleetMachine[];
    onIntroduce: (targetId: string) => void;
    onAsk: () => void;
    onOpen: () => void;
    onNewSession: () => void;
    onConnectApps: () => void;
    onCopyMcpAddress: () => void;
    onRetry: () => void;
    onStart: () => void;
    onUpdate: () => void;
    onRemove: () => void;
    onClose: () => void;
  }

  let { x, y, machine, candidates, onIntroduce, onAsk, onOpen, onNewSession, onConnectApps, onCopyMcpAddress, onRetry, onStart, onUpdate, onRemove, onClose }: Props = $props();

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
    <ContextMenu.Item disabled={!answers} onSelect={() => select(onConnectApps)}>
      <AppWindow />
      Use Solus in other apps…
    </ContextMenu.Item>
    <ContextMenu.Item disabled={!answers} onSelect={() => select(onCopyMcpAddress)}>
      <Copy />
      Copy MCP address
    </ContextMenu.Item>
    {#if candidates.length}
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>
          <Link2 />
          Introduce to
        </ContextMenu.SubTrigger>
        <ContextMenu.SubContent class="min-w-44">
          {#each candidates as candidate (candidate.serverId)}
            <ContextMenu.Item onSelect={() => select(() => onIntroduce(candidate.serverId))}>{candidate.label}</ContextMenu.Item>
          {/each}
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    {/if}
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
