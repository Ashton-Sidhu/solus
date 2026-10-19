<script lang="ts">
  import { untrack } from "svelte";
  import { Maximize, Minimize, X } from "@lucide/svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { localApi } from "@solus/client-core/local-api";
  import type { McpAppHost } from "@solus/client-core/mcp-app-host";
  import { mcpAppDocument, type McpAppRequest, type McpAppSnapshot } from "@solus/contracts/mcp-apps";
  import { getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { connectMcpAppFrame, mcpAppContext } from "./lib/mcp-app-frame";

  /**
   * One MCP App in an opaque-origin frame. Writes, messages, and links wait
   * for the person's approval here; the host checks the call again.
   */
  interface Props {
    snapshot: McpAppSnapshot;
    api: HostApi;
    request: McpAppRequest;
    title: string;
    onSend: (text: string) => boolean;
    onClose: () => void;
    initialHeight?: number;
    onHeight: (height: number) => void;
  }

  let { snapshot, api, request, title, onSend, onClose, initialHeight = 320, onHeight }: Props = $props();

  const settings = getSettingsContext();
  const srcdoc = $derived(mcpAppDocument(snapshot.html, snapshot.csp));
  let frame = $state<HTMLIFrameElement | null>(null);
  let appDialog = $state<HTMLDialogElement | null>(null);
  let confirmDialog = $state<HTMLDialogElement | null>(null);
  let isFullscreen = $state(false);
  let failed = $state(false);
  let height = $state(untrack(() => initialHeight));
  let confirmation = $state<{ title: string; detail: string; resolve: (allowed: boolean) => void } | null>(null);
  let host: McpAppHost | null = null;

  /** One approval at a time: a request while another waits is refused. */
  function confirm(title: string, detail: string): Promise<boolean> {
    if (confirmation) return Promise.resolve(false);
    return new Promise((resolve) => {
      confirmation = { title, detail, resolve };
      confirmDialog?.showModal();
    });
  }

  function decide(allowed: boolean) {
    const pending = confirmation;
    confirmation = null;
    confirmDialog?.close();
    pending?.resolve(allowed);
  }

  /** Full screen is the same dialog in the top layer, so the frame never reloads. */
  function setFullscreen(next: boolean) {
    if (!appDialog || next === isFullscreen) return;
    isFullscreen = next;
    appDialog.close();
    if (next) appDialog.showModal();
    else {
      appDialog.show();
      requestInputFocus();
    }
    host?.updateContext();
  }

  function close() {
    onClose();
    requestInputFocus();
  }

  $effect(() => {
    const target = frame;
    if (!target) return;
    const connection = connectMcpAppFrame(target, {
      snapshot,
      context: () => mcpAppContext(untrack(() => settings.isDark), untrack(() => isFullscreen)),
      toolInfo: (name) => api.mcpAppToolInfo({ ...request, name }),
      callTool: (name, argumentsJson, approved) => api.mcpAppCallTool({ ...request, name, argumentsJson, approved }),
      readResource: (uri) => api.mcpAppReadResource({ ...request, uri }),
      confirm,
      sendMessage: async (text) => {
        if (!onSend(text)) throw new Error("This message could not be queued.");
        requestInputFocus();
      },
      openLink: async (url) => {
        await localApi.openExternal(url);
      },
      displayMode: (mode) => setFullscreen(mode === "fullscreen"),
      resize: (next) => {
        height = next;
        onHeight(next);
      },
      close,
    }, () => (failed = true));
    host = connection.host;
    return () => {
      connection.disconnect();
      host = null;
      decide(false);
    };
  });

  $effect(() => {
    void settings.isDark;
    host?.updateContext();
  });
</script>

<dialog
  bind:this={appDialog}
  open
  aria-label={title}
  oncancel={(event) => {
    event.preventDefault();
    setFullscreen(false);
  }}
  class={isFullscreen
    ? "fixed inset-0 m-0 flex h-full max-h-none w-full max-w-none flex-col border-0 bg-background p-4 text-foreground"
    : "relative mx-0 my-2 block w-full min-w-0 max-w-none border-0 bg-transparent p-0 text-foreground"}
  style:height={isFullscreen ? undefined : `${height}px`}
>
  {#if isFullscreen}
    <div class="flex min-h-11 items-center px-1 text-workspace-chrome font-medium">{title}</div>
  {/if}
  {#if failed}
    <div role="alert" class="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <span>This app could not be displayed.</span>
      <button type="button" class="min-h-11 px-4 text-foreground" onclick={() => (failed = false)}>Try again</button>
    </div>
  {:else}
    <iframe bind:this={frame} {title} sandbox="allow-scripts allow-forms" {srcdoc} class="h-full min-h-0 w-full flex-1 border-0 bg-transparent"></iframe>
  {/if}
  <div class="absolute top-1.5 right-1.5 flex gap-1">
    <button
      type="button"
      aria-label={isFullscreen ? "Exit full screen" : "Open app full screen"}
      class="flex size-8 items-center justify-center rounded-full border border-border bg-card/80 text-muted-foreground hover:text-foreground pointer-coarse:size-11"
      onclick={() => setFullscreen(!isFullscreen)}
    >
      {#if isFullscreen}<Minimize size={13} />{:else}<Maximize size={13} />{/if}
    </button>
    <button
      type="button"
      aria-label="Close app"
      class="flex size-8 items-center justify-center rounded-full border border-border bg-card/80 text-muted-foreground hover:text-foreground pointer-coarse:size-11"
      onclick={close}
    >
      <X size={13} />
    </button>
  </div>
</dialog>

<dialog
  bind:this={confirmDialog}
  oncancel={() => decide(false)}
  class="m-auto max-h-[80dvh] w-full max-w-120 rounded-2xl border border-border bg-popover p-5 text-popover-foreground shadow-xl backdrop:bg-black/40"
>
  {#if confirmation}
    <h2 class="text-base font-semibold">{confirmation.title}</h2>
    <pre class="my-4 max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs">{confirmation.detail}</pre>
    <div class="flex justify-end gap-2">
      <button type="button" class="min-h-11 rounded-full border border-border px-4 text-workspace-chrome" onclick={() => decide(false)}>Cancel</button>
      <button type="button" class="min-h-11 rounded-full bg-primary px-4 text-workspace-chrome text-primary-foreground" onclick={() => decide(true)}>Allow</button>
    </div>
  {/if}
</dialog>
