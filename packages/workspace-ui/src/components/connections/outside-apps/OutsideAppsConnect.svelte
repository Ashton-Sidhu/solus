<script lang="ts">
  /** The Connect step of "Use Solus in other apps": one handoff that gives the
   *  app the host's address (copy first, then open), the address to copy, and
   *  the code that approves the access chosen. "Set up another way" shows the
   *  same with the guide's steps. "Something else…" (no guide) shows only that. */
  import { ExternalLink as ExternalLinkIcon } from "@lucide/svelte";
  import type { AppAccess } from "@solus/contracts/host-api";
  import type { OutsideAppGuide } from "@solus/contracts/outside-apps";
  import { localApi } from "@solus/client-core/local-api";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import { openOutsideApp, outsideAppAction, outsideAppFallback, type LinkOpener } from "../lib/outside-apps";
  import { connectQr } from "../lib/outside-apps-share";
  import { outsideAppsDialog } from "./outside-apps-dialog.svelte";
  import OutsideAppCode from "./OutsideAppCode.svelte";
  import OutsideAppsCopyRow from "./OutsideAppsCopyRow.svelte";
  import OutsideAppsQr from "./OutsideAppsQr.svelte";

  interface Props {
    serverId: string;
    mcpUrl: string;
    /** Null for "Something else…". */
    guide: OutsideAppGuide | null;
    access: AppAccess;
  }

  let { serverId, mcpUrl, guide, access }: Props = $props();

  let isAnotherWay = $state(false);

  const opener: LinkOpener = {
    isWeb: localApi.getPlatform() === "web",
    openExternal: (url) => localApi.openExternal(url),
    assign: (url) => window.location.assign(url),
  };

  const action = $derived(guide ? outsideAppAction(guide, mcpUrl) : null);
  const message = $derived(guide?.handoff.kind === "copy-message" ? guide.handoff.message(mcpUrl) : null);
  const qr = $derived(action ? connectQr(action, mcpUrl) : null);

  function openLink(link: string) {
    void openOutsideApp({ link, appLink: null }, opener);
  }

  async function handOff(app: OutsideAppGuide, open: Extract<ReturnType<typeof outsideAppAction>, { kind: "open" }>) {
    if (open.copy) {
      // The app opens only once the copy lands, so it never reads an older clipboard.
      // A copy that fails shows the value to copy by hand, and the app does not open over it.
      if (!(await outsideAppsDialog.copy(app.handoff.kind === "copy-message" ? "message" : "address", open.copy.text))) return;
      const fallback = outsideAppFallback(open, app.name, opener.isWeb);
      toasts.success(open.copy.title, fallback ? { action: { label: fallback.label, onAction: () => openLink(fallback.link) } } : {});
    }
    if (!(await openOutsideApp(open, opener))) {
      toasts.error(`Could not open ${app.name}`, { description: "Use Set up another way." });
    }
  }
</script>

{#if guide && action && !isAnotherWay}
  <section class="flex flex-col gap-4">
    {#if action.kind === "open"}
      {@const open = action}
      <div class="flex flex-col gap-2">
        <Button class="w-full" onclick={() => void handOff(guide, open)}>
          <ExternalLinkIcon size={16} />
          {open.label}
        </Button>
        {#if guide.note}
          <p class="text-chrome-dense text-(--solus-text-tertiary)">{guide.note}</p>
        {/if}
      </div>
      {#if qr?.kind === "qr"}
        <div class="flex items-center gap-3">
          <OutsideAppsQr value={qr.link} label={`QR code that opens ${guide.name}`} />
          <p class="text-chrome-dense text-(--solus-text-secondary)">Scan to open {guide.name} on your phone</p>
        </div>
      {:else if qr?.kind === "loopback"}
        <p class="text-chrome-dense text-(--solus-text-tertiary)">Another device cannot open a localhost address. Copy it for use on this computer.</p>
      {/if}
    {:else}
      <div class="flex flex-col gap-2">
        {#each action.commands as command, index (command)}
          <OutsideAppsCopyRow label={`Command ${index + 1}`} kind="command" value={command} />
        {/each}
        <p class="text-chrome-dense text-(--solus-text-tertiary)">Run these where {guide.name} runs.</p>
        {#if guide.note}
          <p class="text-chrome-dense text-(--solus-text-tertiary)">{guide.note}</p>
        {/if}
      </div>
    {/if}
    <OutsideAppsCopyRow label="Address" kind="address" value={mcpUrl} />
    <OutsideAppCode {serverId} {access} />
    <div>
      <button
        type="button"
        class="text-workspace-chrome font-medium text-(--solus-text-primary) underline-offset-4 outline-none hover:underline focus-visible:underline"
        onclick={() => (isAnotherWay = true)}
      >
        Set up another way
      </button>
    </div>
  </section>
{:else}
  <section class="flex flex-col gap-4">
    <OutsideAppsCopyRow label="Address" kind="address" value={mcpUrl} />
    {#if message}
      <OutsideAppsCopyRow label="Message" kind="message" value={message} />
    {/if}
    <ol class="flex list-decimal flex-col gap-1 pl-5 text-workspace-chrome text-(--solus-text-secondary)">
      {#each guide?.steps ?? ["Add a remote MCP server with OAuth."] as step (step)}
        <li>{step}</li>
      {/each}
    </ol>
    {#if !guide}
      <p class="text-chrome-dense text-(--solus-text-tertiary)">Apps that require their own client ID cannot connect.</p>
    {:else}
      {#if guide.note}
        <p class="text-chrome-dense text-(--solus-text-tertiary)">{guide.note}</p>
      {/if}
      {#if guide.docs}
        {@const docs = guide.docs}
        <div>
          <button
            type="button"
            class="text-workspace-chrome text-(--solus-text-secondary) underline-offset-4 outline-none hover:text-(--solus-text-primary) hover:underline focus-visible:underline"
            onclick={() => openLink(docs)}
          >
            {guide.name} help
          </button>
        </div>
      {/if}
    {/if}
    <OutsideAppCode {serverId} {access} />
    {#if guide}
      <div>
        <button
          type="button"
          class="text-workspace-chrome font-medium text-(--solus-text-primary) underline-offset-4 outline-none hover:underline focus-visible:underline"
          onclick={() => (isAnotherWay = false)}
        >
          {guide.handoff.kind === "commands" ? "Back to commands" : "Back to one click"}
        </button>
      </div>
    {/if}
  </section>
{/if}
