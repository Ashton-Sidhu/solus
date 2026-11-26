<script lang="ts">
  /** "Tailscale" in the address gate (plans/035 §0.8). Serve gives the host an
   *  https address on the person's tailnet, for apps on their own devices.
   *  Funnel opens that address to the internet, for cloud apps. Both need
   *  local reach, so only the owner on the host's computer changes them here. */
  import { LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import { connectionsStore } from "../../../contexts";
  import { hosts } from "../../../contexts/hosts/hosts.svelte";
  import { Button } from "../../ui/button";
  import { tailscaleWay, type AppAddressReach } from "../lib/app-addresses";
  import { tailscaleServeStateText } from "../lib/tailscale-serve";
  import { outsideAppsDialog } from "./outside-apps-dialog.svelte";

  interface Props {
    serverId: string;
    hostName: string;
    reach: AppAddressReach;
  }

  let { serverId, hostName, reach }: Props = $props();

  const status = $derived(connectionsStore.appTailscaleFor(serverId) ?? null);
  const way = $derived(tailscaleWay(status, hosts.get(serverId).me.may("host.local.reach")));
  const isBusy = $derived(connectionsStore.appTailscaleBusyServerId === serverId);
  const error = $derived(connectionsStore.appTailscaleErrorFor(serverId) ?? status?.error ?? null);
</script>

{#snippet checkAgain()}
  <div>
    <Button variant="outline" size="sm" onclick={() => void outsideAppsDialog.check(serverId)}>Check again</Button>
  </div>
{/snippet}

{#if reach === "internet"}
  <p class="text-chrome-dense text-(--solus-text-secondary)">Tailscale Serve alone is for apps on your own devices in your tailnet, not for cloud apps. Funnel opens the address to the internet. Only apps you approve can sign in.</p>
{:else}
  <p class="text-chrome-dense text-(--solus-text-secondary)">Tailscale Serve gives {hostName} an https address on your tailnet. Apps on your devices in the tailnet can use it. Cloud apps also need Funnel.</p>
{/if}
{#if error}
  <p role="alert" class="text-chrome-dense text-(--solus-status-error) select-text">{error}</p>
{/if}
{#if way === "unknown"}
  <p class="text-chrome-dense text-(--solus-text-secondary)">Tailscale does not answer on {hostName}. Install Tailscale there and sign in, then check again.</p>
  {@render checkAgain()}
{:else if way === "turn-on-serve"}
  <div class="flex flex-wrap items-center gap-2">
    <Button size="sm" disabled={isBusy} onclick={() => void outsideAppsDialog.turnOnTailscaleServe(serverId)}>
      {#if isBusy}<SpinnerIcon size={14} class="motion-safe:animate-spin" />Turning on…{:else}Turn on Tailscale Serve{/if}
    </Button>
  </div>
  <p class="text-chrome-dense text-(--solus-text-tertiary)">To choose its port, use Tailscale HTTPS in Settings › Sharing & access › Network.</p>
{:else if way === "serve-elsewhere"}
  <p class="text-chrome-dense text-(--solus-text-secondary)">On {hostName}, open Settings › Sharing & access and turn on Tailscale HTTPS{reach === "internet" ? ", then Funnel" : ""}.</p>
  {@render checkAgain()}
{:else if way === "serve-waiting"}
  <p class="text-chrome-dense text-(--solus-text-secondary)">Tailscale Serve: {status ? tailscaleServeStateText(status.state) : ""}.</p>
  {@render checkAgain()}
{:else if way === "turn-on-funnel"}
  <div>
    <Button size="sm" disabled={isBusy} onclick={() => void outsideAppsDialog.turnOnTailscaleFunnel(serverId)}>
      {#if isBusy}<SpinnerIcon size={14} class="motion-safe:animate-spin" />Turning on…{:else}Turn on Funnel{/if}
    </Button>
  </div>
{:else if way === "funnel-elsewhere"}
  <p class="text-chrome-dense text-(--solus-text-secondary)">On {hostName}, open Use Solus in other apps and turn on Funnel there.</p>
  {@render checkAgain()}
{:else}
  <p class="text-chrome-dense text-(--solus-text-secondary)">Funnel is on. Tailscale gives the address in a moment.</p>
  {@render checkAgain()}
{/if}
