<script lang="ts">
  /** What stands between a person and the steps of "Use Solus in other apps"
   *  (`resolveOutsideAppGate`): checking, a host with no address the app
   *  reaches (three ways to give it one), and a host or address that does not
   *  answer. A host does not have to be linked to a Solus account
   *  (plans/035 §0.8). */
  import { LoaderCircle as SpinnerIcon, TriangleAlert as WarningIcon } from "@lucide/svelte";
  import { connectionsStore } from "../../../contexts";
  import { Button } from "../../ui/button";
  import { appAddressSourceLabel } from "../lib/app-addresses";
  import type { OutsideAppGate } from "../lib/outside-apps-gate";
  import { outsideAppsDialog } from "./outside-apps-dialog.svelte";
  import OutsideAppsOwnAddress from "./OutsideAppsOwnAddress.svelte";
  import OutsideAppsSolusChoice from "./OutsideAppsSolusChoice.svelte";
  import OutsideAppsTailscaleChoice from "./OutsideAppsTailscaleChoice.svelte";

  interface Props {
    serverId: string;
    hostName: string;
    /** The app chosen; null before a choice and for "Something else…". */
    appName: string | null;
    gate: Exclude<OutsideAppGate, { kind: "open" }>;
  }

  let { serverId, hostName, appName, gate }: Props = $props();

  // Serve on: Funnel is one step away, so the Tailscale choice opens first.
  const isServeOn = $derived(connectionsStore.appTailscaleFor(serverId)?.enabled === true);
</script>

{#snippet checkAgain()}
  <div>
    <Button variant="outline" size="sm" onclick={() => void outsideAppsDialog.check(serverId)}>Check again</Button>
  </div>
{/snippet}

{#snippet choice(title: string, summary: string, isOpen: boolean, body: import("svelte").Snippet)}
  <details name="outside-apps-address-choice" open={isOpen} class="group rounded-lg border border-border open:border-(--solus-text-tertiary)/40">
    <summary class="flex cursor-pointer list-none flex-col gap-0.5 rounded-lg px-3 py-2.5 outline-none hover:bg-(--solus-surface-hover) focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
      <span class="text-workspace-chrome font-medium text-(--solus-text-primary)">{title}</span>
      <span class="text-chrome-dense text-(--solus-text-secondary)">{summary}</span>
    </summary>
    <div class="flex flex-col gap-3 px-3 pt-1 pb-3">
      {@render body()}
    </div>
  </details>
{/snippet}

{#snippet solusBody()}
  {#if gate.kind === "no-address"}
    <OutsideAppsSolusChoice {serverId} {hostName} solus={gate.solus} />
  {/if}
{/snippet}

{#snippet tailscaleBody()}
  {#if gate.kind === "no-address"}
    <OutsideAppsTailscaleChoice {serverId} {hostName} reach={gate.reach} />
  {/if}
{/snippet}

{#snippet ownAddressBody()}
  <OutsideAppsOwnAddress {serverId} {hostName} />
{/snippet}

<section class="flex flex-col gap-3" aria-live="polite">
  {#if gate.kind === "checking"}
    <p role="status" class="flex items-center gap-2 text-workspace-chrome text-(--solus-text-secondary)">
      <SpinnerIcon size={16} class="motion-safe:animate-spin" />
      {gate.testSource ? `Testing the address of ${hostName}…` : `Checking ${hostName}…`}
    </p>
  {:else if gate.kind === "no-address"}
    <h3 class="text-base font-medium text-pretty text-(--solus-text-primary)">Give {hostName} an address apps can reach</h3>
    <div class="flex flex-col gap-1 text-workspace-chrome text-(--solus-text-secondary)">
      {#if gate.reach === "internet"}
        <p>{appName ?? "This app"} runs in the cloud. It needs an address on the internet to reach {hostName}.</p>
      {:else}
        <p>An app on another computer needs an address that reaches {hostName}.</p>
      {/if}
      <p>Choose one way. Each app still needs your approval.</p>
    </div>
    <div class="flex flex-col gap-2">
      {@render choice("Link to your Solus account", "Solus Cloud gives the host a public https address, with no router setup.", !isServeOn, solusBody)}
      {@render choice("Tailscale", gate.reach === "internet" ? "Tailscale Funnel opens the host's tailnet address to the internet." : "Tailscale Serve gives the host an https address on your tailnet.", isServeOn, tailscaleBody)}
      {@render choice("Use your own address", "A reverse proxy or a tunnel of your own that serves the host over https.", false, ownAddressBody)}
    </div>
  {:else if gate.kind === "offline"}
    <h3 class="text-base font-medium text-pretty text-(--solus-text-primary)">
      {#if gate.where === "host"}
        Solus cannot reach {hostName}
      {:else}
        {hostName} does not answer at its {gate.address ? appAddressSourceLabel(gate.address.source) : ""} address
      {/if}
    </h3>
    <div class="flex flex-col gap-1 text-workspace-chrome text-(--solus-text-secondary) select-text">
      {#if gate.address}<p><code class="font-mono text-chrome-dense break-all">{gate.address.url}</code></p>{/if}
      <p>{gate.reason}</p>
    </div>
    {#if gate.canGoOn && gate.address}
      {@const url = gate.address.url}
      <p class="flex items-start gap-2 text-chrome-dense text-(--solus-text-secondary)">
        <WarningIcon size={16} class="mt-px shrink-0 text-(--warning)" />
        {hostName} cannot reach its own address from itself. Your router may not send it back in, and other devices and cloud apps may still reach it.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onclick={() => void outsideAppsDialog.check(serverId)}>Check again</Button>
        <Button size="sm" onclick={() => outsideAppsDialog.goOnUntested(url)}>Go on anyway</Button>
      </div>
    {:else}
      {@render checkAgain()}
    {/if}
  {/if}
</section>
