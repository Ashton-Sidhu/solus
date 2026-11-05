<script lang="ts">
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { providerStatusCheckedLabel, providerStatusLabel } from "@solus/client-core/provider-instances";
  import type { ProviderInstancesClient, ProviderInstancesView } from "@solus/client-core/provider-instances";
  import { Button } from "../ui/button";
  import CopyButton from "../ui/CopyButton.svelte";
  import { Dialog } from "bits-ui";
  import { Input } from "../ui/input";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  let { instanceId, client, view }: { instanceId: string; client: ProviderInstancesClient; view: ProviderInstancesView } = $props();
  const status = $derived(view.statuses.get(instanceId));
  const statusDescription = $derived(
    [providerStatusLabel(status), status?.version, status && providerStatusCheckedLabel(status.checkedAt)].filter(Boolean).join(" · "),
  );
  const verification = $derived(view.verification?.instanceId === instanceId ? view.verification.result : null);
  let code = $state("");
  let revealAccount = $state(false);
  let confirmSignOut = $state(false);

  // A modal: shortcuts behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true, active: () => confirmSignOut });
</script>

<SettingsSection label="Status and account">
  <SettingsRow label="Status" description={statusDescription} bodyVisible={Boolean(status?.account || status?.error)}>
    {#snippet control()}<Button variant="ghost" size="sm" onclick={() => void client.inspect(instanceId)}>Refresh status</Button>{/snippet}
    {#snippet body()}
      <div class="flex flex-col items-start gap-2 text-sm">
        {#if status?.account}<Button variant="ghost" size="sm" class="-ml-2" onclick={() => (revealAccount = !revealAccount)}>{revealAccount ? status.account : "Show account details"}</Button>{/if}
        {#if status?.error}<p role="alert" class="text-destructive">{status.error}</p>{/if}
      </div>
    {/snippet}
  </SettingsRow>
  <SettingsRow label="Account" description="The provider CLI saves its login in this instance's home on the host.">
    {#snippet control()}
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={view.action !== null || status?.phase === "connecting"} onclick={() => void client.signIn(instanceId)}>{status?.authenticated ? "Change account" : "Sign in"}</Button>
        {#if status?.authenticated}<Button variant="ghost" size="sm" disabled={view.action !== null} onclick={() => (confirmSignOut = true)}>Sign out</Button>{/if}
      </div>
    {/snippet}
    {#snippet body()}
      {#if verification}
        <div class="flex flex-col gap-3 text-sm">
          <a class="w-fit underline underline-offset-4" href={verification.verificationUrl} target="_blank" rel="noreferrer">Open sign-in page</a>
          <div><CopyButton text={verification.verificationUrl} title="Copy sign-in link" /></div>
          {#if verification.userCode}<p>Device code: <code>{verification.userCode}</code></p>{/if}
          {#if verification.requiresCodeInput}<form class="flex gap-2" onsubmit={(event) => { event.preventDefault(); void client.submitCode(instanceId, code); }}><Input aria-label="Provider sign-in code" bind:value={code} autocomplete="off" /><Button type="submit" size="sm" disabled={!code.trim()}>Submit code</Button></form>{/if}
          <Button variant="ghost" size="sm" class="w-fit" onclick={() => void client.cancelSignIn(instanceId)}>Cancel sign-in</Button>
        </div>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>

<Dialog.Root bind:open={confirmSignOut}>
  <Dialog.Portal><Dialog.Overlay class="fixed inset-0 z-50 bg-black/30" />
    <Dialog.Content class="fixed top-1/2 left-1/2 z-50 flex w-[min(28rem,calc(100%-2rem))] -translate-1/2 flex-col gap-4 rounded-xl border border-border bg-background p-6 text-workspace-chrome shadow-lg">
      <Dialog.Title class="text-lg font-medium">Sign out of this provider account?</Dialog.Title>
      <Dialog.Description class="text-sm text-muted-foreground">Other instances that use the same provider home share this login. New turns need a valid login.</Dialog.Description>
      <div class="flex justify-end gap-2"><Button variant="ghost" size="sm" onclick={() => (confirmSignOut = false)}>Cancel</Button><Button variant="outline" size="sm" onclick={() => { confirmSignOut = false; void client.signOut(instanceId); }}>Sign out</Button></div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
