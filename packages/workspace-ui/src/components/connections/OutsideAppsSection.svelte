<script lang="ts">
  /** "Use Solus in other apps" on Settings › Sharing & access (plans/035 §10). The steps
   *  are in one dialog (`OutsideAppsDialog`), which the palette and the host menu
   *  open too. Every person who uses the host sees it, and an app they approve
   *  acts as them. The apps that signed in are in the paired devices list, with
   *  their access and Revoke. Below, the addresses apps reach the host at, each
   *  with its last test, and "Use your own address" (plans/035 §0.8). */
  import { untrack } from "svelte";
  import { AppWindow as AppWindowIcon } from "@lucide/svelte";
  import { connectionsStore } from "../../contexts";
  import { relativeTime } from "../../lib/relative-time";
  import { Button } from "../ui/button";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { appAddressRows, appAddressTestText } from "./lib/app-addresses";
  import { hostLabel, outsideAppsDialog } from "./outside-apps/outside-apps-dialog.svelte";
  import OutsideAppsCopyRow from "./outside-apps/OutsideAppsCopyRow.svelte";
  import OutsideAppsOwnAddress from "./outside-apps/OutsideAppsOwnAddress.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  $effect(() => {
    const targetServerId = serverId;
    untrack(() => void connectionsStore.loadAppEndpoint(targetServerId));
  });

  const endpoint = $derived(connectionsStore.appEndpointFor(serverId));
  const endpointError = $derived(connectionsStore.appEndpointErrorFor(serverId));
  const rows = $derived(endpoint ? appAddressRows(endpoint) : []);
  const tests = $derived(connectionsStore.appAddressTestsFor(serverId));
</script>

<SettingsSection label="Use Solus in other apps">
  <SettingsRow
    label="Connect an app"
    description="Claude, ChatGPT, Cursor, Claude Code, and other MCP apps can use this host's tools as you. You choose what each app can do, and you approve it."
  >
    {#snippet control()}
      <Button variant="outline" size="sm" onclick={() => outsideAppsDialog.open(serverId)}>
        <AppWindowIcon size={14} />
        Connect an app
      </Button>
    {/snippet}
  </SettingsRow>

  <SettingsRow label="Addresses for apps" description="Where apps reach this host. Cloud apps need an internet address; apps on your devices can also use your tailnet.">
    {#snippet body()}
      {#if endpointError}
        <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{endpointError}</p>
      {:else if !endpoint}
        <p class="text-chrome-dense text-(--solus-text-tertiary)">Reading addresses…</p>
      {:else}
        <ul class="flex flex-col gap-3">
          {#each rows as row (row.source ?? "local")}
            {@const test = row.source ? tests[row.source] : undefined}
            {@const testText = appAddressTestText(test, row.url)}
            <li class="flex min-w-0 flex-col gap-1.5">
              <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <p class="flex min-w-0 items-baseline gap-2">
                  <span class="truncate text-workspace-chrome font-medium text-(--solus-text-primary)">{row.label}</span>
                  <span class="shrink-0 text-chrome-dense text-(--solus-text-tertiary)">{row.reach}</span>
                </p>
                {#if row.source}
                  {@const source = row.source}
                  <Button variant="ghost" size="sm" disabled={test?.kind === "running"} onclick={() => void connectionsStore.testAppAddress(serverId, source)}>
                    {test?.kind === "running" ? "Testing…" : "Test"}
                  </Button>
                {/if}
              </div>
              <OutsideAppsCopyRow label="Address" kind="address" value={row.url} />
              {#if testText && test}
                <p
                  role={test.kind === "done" && test.reachable ? "status" : "alert"}
                  class={["text-chrome-dense select-text", test.kind === "done" && test.reachable ? "text-(--solus-status-complete)" : test.kind === "running" ? "text-(--solus-text-tertiary)" : "text-(--solus-status-error)"]}
                >
                  {testText}{#if test.kind === "done"}<span class="text-(--solus-text-tertiary)"> · {relativeTime(test.checkedAt)}</span>{/if}
                </p>
              {/if}
            </li>
          {/each}
        </ul>
        {#if rows.length === 1}
          <p class="mt-3 text-chrome-dense text-(--solus-text-tertiary)">Only apps on this host's computer reach it. Connect an app to give it an address other apps reach.</p>
        {/if}
      {/if}
    {/snippet}
  </SettingsRow>

  <SettingsRow label="Use your own address" description="The https address of a reverse proxy or a tunnel of your own that serves this host.">
    {#snippet body()}
      <OutsideAppsOwnAddress {serverId} hostName={hostLabel(serverId)} />
    {/snippet}
  </SettingsRow>
</SettingsSection>
