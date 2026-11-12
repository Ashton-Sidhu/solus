<script lang="ts">
  import { Plug as ConnectIcon, ShieldCheck as HostAccessIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { getSurfaceContext } from "../../contexts";
  import type { AppFrame } from "./app-frame.svelte";

  /**
   * What an app shows above its frame (docs/plans/apps.md §6): the
   * integrations the viewer still has to connect, the host access it asks
   * for or has, with Allow and Revoke for the host's owner, and the approval
   * a call waits on. An artifact that is not an app renders nothing here.
   */
  let { app, inPane = false }: { app: AppFrame; /** The app has all of a pane: the bars keep their own margin from its edges. */ inPane?: boolean } = $props();

  const session = getSurfaceContext();
  const hostAccess = $derived(app.state?.hostAccess ?? null);

  let confirmDialog = $state<HTMLDialogElement | null>(null);
  // The dialog is in the top layer, above a full-screen render; it opens when a call asks and closes when the person answers.
  $effect(() => {
    if (app.confirmation) confirmDialog?.showModal();
    else confirmDialog?.close();
  });
</script>

{#if app.missingRoles.length > 0}
  <div class="mb-2 flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-workspace-chrome text-muted-foreground {inPane ? 'mx-4 mt-3' : ''}" role="status" data-testid="app-connect">
    <ConnectIcon size={14} class="shrink-0" />
    <span class="min-w-0 flex-1">
      This app uses {app.missingRoles.map((role) => role.name ?? role.slug).join(", ")} with your own account. Connect {app.missingRoles.length === 1 ? "it" : "them"}, then reload the app.
    </span>
    {#if session.workspace}
      <Button variant="outline" size="sm" class="shrink-0 rounded-full text-workspace-chrome pointer-coarse:h-10" onclick={() => session.workspace?.showSettings("mcp")}>
        Open Settings → MCP
      </Button>
    {/if}
  </div>
{/if}

{#if app.notice && hostAccess}
  <div class="mb-2 flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-workspace-chrome text-muted-foreground {inPane ? 'mx-4 mt-3' : ''}" role="status" data-testid="app-host-access">
    <HostAccessIcon size={14} class="shrink-0" />
    <span class="min-w-0 flex-1">{app.notice}</span>
    {#if hostAccess.canDecide}
      {#if hostAccess.state === "pending"}
        <Button size="sm" class="shrink-0 rounded-full text-workspace-chrome pointer-coarse:h-10" data-testid="app-host-access-allow" onclick={() => app.decideHostAccess(true)}>Allow</Button>
      {:else}
        <Button variant="outline" size="sm" class="shrink-0 rounded-full text-workspace-chrome pointer-coarse:h-10" data-testid="app-host-access-revoke" onclick={() => app.decideHostAccess(false)}>Revoke</Button>
      {/if}
    {/if}
  </div>
{/if}

<dialog
  bind:this={confirmDialog}
  oncancel={() => app.settle(false)}
  class="m-auto max-h-[80dvh] w-full max-w-120 rounded-2xl border border-border bg-popover p-5 text-popover-foreground shadow-xl backdrop:modal-backdrop"
>
  {#if app.confirmation}
    <h2 class="text-base font-semibold">{app.confirmation.title}</h2>
    <pre class="my-4 max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs">{app.confirmation.detail}</pre>
    <div class="flex justify-end gap-2">
      <Button variant="outline" class="min-h-11 rounded-full px-4 text-workspace-chrome" onclick={() => app.settle(false)}>Cancel</Button>
      <Button class="min-h-11 rounded-full px-4 text-workspace-chrome" onclick={() => app.settle(true)}>Allow</Button>
    </div>
  {/if}
</dialog>
