<script lang="ts">
  /** What an open row shows before its app can connect
   *  (`resolveOutsideAppGate`): checking, a host with no address the app
   *  reaches (the three ways to give it one), and a host or address that does
   *  not answer. A host does not have to be linked to a Solus account
   *  (plans/035 §0.8). */
  import { LoaderCircle as SpinnerIcon, TriangleAlert as WarningIcon } from "@lucide/svelte";
  import { Button } from "../../ui/button";
  import { appAddressSourceLabel } from "../lib/app-addresses";
  import type { OutsideAppGate } from "../lib/outside-apps-gate";
  import { outsideApps } from "./outside-apps.svelte";
  import OutsideAppsAddressWays from "./OutsideAppsAddressWays.svelte";

  interface Props {
    serverId: string;
    hostName: string;
    appName: string;
    gate: Exclude<OutsideAppGate, { kind: "open" }>;
  }

  let { serverId, hostName, appName, gate }: Props = $props();
</script>

<section class="flex flex-col gap-3" aria-live="polite">
  {#if gate.kind === "checking"}
    <p role="status" class="flex items-center gap-2 text-workspace-chrome text-(--solus-text-secondary)">
      <SpinnerIcon size={16} class="motion-safe:animate-spin" />
      {gate.testSource ? `Testing the address of ${hostName}…` : `Checking ${hostName}…`}
    </p>
  {:else if gate.kind === "no-address"}
    <p class="text-[0.8125rem] leading-[1.45] text-(--solus-text-secondary)">
      {#if gate.reach === "internet"}
        {appName} runs in the cloud. It needs an address on the internet to reach {hostName}. Pick one way:
      {:else}
        An app on another computer needs an address that reaches {hostName}. Pick one way:
      {/if}
    </p>
    <div class="rounded-[0.875rem] bg-(--solus-tx-card-bg) p-2 shadow-[shadow:var(--solus-card-shadow-collapsed)]">
      <OutsideAppsAddressWays {serverId} {hostName} reach={gate.reach} />
    </div>
  {:else}
    <div class="flex flex-col gap-1 text-[0.8125rem] leading-[1.45] text-(--solus-text-secondary) select-text">
      <p class="font-medium text-(--solus-text-primary)">
        {#if gate.where === "host"}
          Solus cannot reach {hostName}
        {:else}
          {hostName} does not answer at its {gate.address ? appAddressSourceLabel(gate.address.source) : ""} address
        {/if}
      </p>
      {#if gate.address}<p class="break-all">{gate.address.url}</p>{/if}
      <p>{gate.reason}</p>
    </div>
    {#if gate.canGoOn && gate.address}
      <p class="flex items-start gap-2 text-chrome-dense text-(--solus-text-secondary)">
        <WarningIcon size={16} class="mt-px shrink-0 text-(--warning)" />
        {hostName} cannot reach its own address from itself. Your router may not send it back in, and other devices and cloud apps may still reach it.
      </p>
    {/if}
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" class="pointer-coarse:min-h-11" onclick={() => void outsideApps.check(serverId)}>Check again</Button>
      {#if gate.canGoOn && gate.address}
        {@const url = gate.address.url}
        <Button size="sm" class="pointer-coarse:min-h-11" onclick={() => outsideApps.goOnUntested(url)}>Go on anyway</Button>
      {/if}
    </div>
  {/if}
</section>
