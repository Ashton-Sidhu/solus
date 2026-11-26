<script lang="ts">
  /** Linear on the Integrations page. Connect and Replace key take the key in
   *  a dialog, so the page stays a list of rows. The page loads the
   *  connection and passes its state down. */
  import { Ellipsis } from "@lucide/svelte";
  import type { KeyConnectionState, KeyConnectionStore } from "@solus/client-core/key-connection-store";
  import { accountStore } from "../../contexts/account/account.store.svelte";
  import { hosts } from "../../contexts/hosts/hosts.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Input } from "../ui/input";
  import IntegrationDialog from "./IntegrationDialog.svelte";
  import IntegrationRow from "./IntegrationRow.svelte";
  import { PROVIDER_LOGOS } from "./lib/provider-logos";

  interface Props {
    serverId: string;
    connection: KeyConnectionStore;
    linear: KeyConnectionState;
  }

  let { serverId, connection, linear }: Props = $props();
  let key = $state("");
  let isDialogOpen = $state(false);
  const canManage = $derived(linear.location === "account" ? accountStore.isSignedIn : linear.location === "host" && hosts.get(serverId).me.may("host.admin.connections"));
  const description = $derived(
    linear.connected
      ? `Connected${linear.label ? ` as ${linear.label}` : ""}${linear.location === "account" ? " in your Solus account" : " on this host"}`
      : "Read and update Linear issues from Issues.",
  );

  function openDialog() {
    key = "";
    isDialogOpen = true;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const draft = key;
    key = "";
    if (await connection.save(draft)) {
      isDialogOpen = false;
      requestInputFocus();
    }
  }

  async function disconnect() {
    if (await connection.disconnect()) requestInputFocus();
  }
</script>

<IntegrationRow name="Linear" logo={PROVIDER_LOGOS.linear} {description} isConnected={linear.connected}
  error={isDialogOpen ? null : linear.error} testId="connections-row-linear">
  {#snippet action()}
    {#if linear.connected}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="ghost" size="icon-sm" class="text-muted-foreground pointer-coarse:tap-area" disabled={!canManage || linear.pending} aria-label="More actions for Linear"><Ellipsis size={16} /></Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[min(16rem,calc(100vw-2rem))]">
          <DropdownMenu.Item onSelect={openDialog}>Replace key</DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item variant="destructive" onSelect={() => void disconnect()}>Disconnect</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {:else if canManage}
      <Button variant="outline" size="sm" class="border-border/70 text-workspace-chrome shadow-xs pointer-coarse:min-h-11"
        disabled={linear.pending} onclick={openDialog} aria-label="Connect Linear">Connect</Button>
    {:else}
      <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11"
        disabled={linear.loading} onclick={() => void connection.load()}>Try again</Button>
    {/if}
  {/snippet}
</IntegrationRow>

<IntegrationDialog
  bind:isOpen={isDialogOpen}
  title={linear.connected ? "Replace the Linear key" : "Connect Linear"}
  description="Read and update Linear issues from Issues."
  logo={PROVIDER_LOGOS.linear}
  onClose={() => (key = "")}
  testId="linear-connect-dialog"
>
  <form class="flex flex-col gap-4" onsubmit={save}>
    <div class="flex flex-col gap-1">
      <label for="linear-key-{serverId}" class="text-xs font-medium text-foreground">API key</label>
      <Input id="linear-key-{serverId}" type="password" bind:value={key} autocomplete="new-password" maxlength={4096} disabled={linear.pending}
        aria-describedby="linear-key-{serverId}-help" class="text-workspace-chrome" />
      <p id="linear-key-{serverId}-help" class="text-pretty text-xs text-muted-foreground">
        Create a personal API key in Linear Settings → Security &amp; access.
        {linear.location === "account" ? "Solus saves it in your account vault for use on your hosts." : "Solus saves it in the secure vault on this host."}
      </p>
    </div>
    {#if linear.error}<p role="alert" class="text-pretty text-xs text-(--solus-status-error)">{linear.error}</p>{/if}
    <div>
      <Button type="submit" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={!key.trim() || linear.pending}>
        {linear.pending ? "Saving…" : linear.connected ? "Save key" : "Connect"}
      </Button>
    </div>
  </form>
</IntegrationDialog>
