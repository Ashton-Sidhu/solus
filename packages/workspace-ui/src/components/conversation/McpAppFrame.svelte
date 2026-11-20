<script lang="ts">
  import { untrack } from "svelte";
  import { Bot, ChevronDown, ChevronRight, Maximize, Minimize, Shield, X } from "@lucide/svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { localApi } from "@solus/client-core/local-api";
  import type { McpAppConfirmFormat, McpAppHost, McpAppLiveCall } from "@solus/client-core/mcp-app-host";
  import { mcpAppAllowAttribute, mcpAppPermissionLabel, mcpAppPermissionPrompt, mcpAppPermissionRequest } from "@solus/client-core/mcp-app-permissions";
  import { mcpAppDocument, type McpAppCancelReason, type McpAppLiveDocument, type McpAppPermission, type McpAppRequest, type McpAppSnapshot } from "@solus/contracts/mcp-apps";
  import { Button } from "../ui/button";
  import { getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { connectMcpAppFrame, mcpAppContext, mcpAppSupportedPermissions } from "./lib/mcp-app-frame";

  /**
   * One MCP App in an opaque-origin frame. Writes, messages, links, and
   * browser features wait for the person's approval here; the host checks a
   * call again. Below the frame, the person sees what the app asks for and
   * what it gave the agent.
   */
  interface Props {
    /** A saved app, or the document of a live card whose call has not ended. */
    snapshot: McpAppSnapshot | McpAppLiveDocument;
    /** A live card's call as the transcript shows it now; null while its hidden conversation runs it. */
    call?: McpAppLiveCall | null;
    /** A live card's saved app, once its call ended. */
    savedCall?: Pick<McpAppSnapshot, "toolInputJson" | "toolResultJson">;
    api: HostApi;
    request: McpAppRequest;
    title: string;
    onSend: (text: string) => boolean;
    /** With a reason when a live card's call gave no result. */
    onClose: (cancelled?: McpAppCancelReason) => void;
    initialHeight?: number;
    onHeight: (height: number) => void;
    /** The context this app gave the agent; undefined when it gave none. */
    modelContext: string | undefined;
    onModelContext: (text: string) => void;
    /** The browser features the person granted this app. */
    permissions: McpAppPermission[];
    onPermissions: (granted: McpAppPermission[]) => void;
  }

  let { snapshot, call, savedCall, api, request, title, onSend, onClose, initialHeight = 320, onHeight, modelContext, onModelContext, permissions, onPermissions }: Props = $props();

  const settings = getSettingsContext();
  const srcdoc = $derived(mcpAppDocument(snapshot.html, snapshot.csp));
  const allow = $derived(mcpAppAllowAttribute(permissions));
  const requestedPermissions = $derived(mcpAppPermissionRequest(snapshot.permissions, mcpAppSupportedPermissions()).filter((permission) => !permissions.includes(permission)));
  let isContextOpen = $state(false);
  let frame = $state<HTMLIFrameElement | null>(null);
  let appDialog = $state<HTMLDialogElement | null>(null);
  let confirmDialog = $state<HTMLDialogElement | null>(null);
  let isFullscreen = $state(false);
  let failed = $state(false);
  let height = $state(untrack(() => initialHeight));
  let confirmation = $state<{ title: string; detail: string; format: McpAppConfirmFormat; resolve: (allowed: boolean) => void } | null>(null);
  let host = $state.raw<McpAppHost | null>(null);

  /** One approval at a time: a request while another waits is refused. */
  function confirm(title: string, detail: string, format: McpAppConfirmFormat): Promise<boolean> {
    if (confirmation) return Promise.resolve(false);
    return new Promise((resolve) => {
      confirmation = { title, detail, format, resolve };
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

  function close(cancelled?: McpAppCancelReason) {
    onClose(cancelled);
    requestInputFocus();
  }

  /** A granted feature reaches the app only through a new frame, so the app starts again with it. */
  async function grantPermissions() {
    const requested = requestedPermissions;
    const prompt = mcpAppPermissionPrompt(title, requested);
    if (await confirm(prompt.title, prompt.detail, "text")) onPermissions([...permissions, ...requested]);
    requestInputFocus();
  }

  $effect(() => {
    const target = frame;
    if (!target) return;
    const connection = connectMcpAppFrame(target, {
      snapshot,
      title,
      context: () => mcpAppContext(target, untrack(() => settings.isDark), untrack(() => isFullscreen)),
      permissions: () => untrack(() => permissions),
      toolInfo: (name) => api.mcpAppToolInfo({ ...request, name }),
      callTool: (name, argumentsJson, approved) => api.mcpAppCallTool({ ...request, name, argumentsJson, approved }),
      readResource: (uri) => api.mcpAppReadResource({ ...request, uri }),
      confirm,
      sendMessage: async (text) => {
        if (!onSend(text)) throw new Error("This message could not be queued.");
        requestInputFocus();
      },
      updateModelContext: async (text) => {
        await api.mcpAppUpdateModelContext({ ...request, text });
        onModelContext(text);
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
    }, () => (failed = true), () => untrack(() => isFullscreen));
    host = connection.host;
    return () => {
      connection.disconnect();
      host = null;
      decide(false);
    };
  });

  $effect(() => {
    void settings.isDark;
    untrack(() => host)?.updateContext();
  });

  // A live card follows its call. The bridge heals and limits partial input.
  $effect(() => {
    if (host && call) host.followCall(call);
  });

  $effect(() => {
    if (host && savedCall) host.toolResult(savedCall);
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
    : snapshot.prefersBorder
      ? "relative mx-0 my-2 block w-full min-w-0 max-w-none overflow-hidden rounded-lg border border-border bg-card p-0 text-foreground"
      : "relative mx-0 my-2 block w-full min-w-0 max-w-none border-0 bg-transparent p-0 text-foreground"}
  style:height={isFullscreen ? undefined : `${height}px`}
>
  {#if isFullscreen}
    <div class="flex min-h-11 items-center px-1 text-workspace-chrome font-medium">{title}</div>
  {/if}
  {#if failed}
    <div role="alert" class="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <span>This app could not be displayed.</span>
      <Button variant="ghost" class="pointer-coarse:h-11" onclick={() => (failed = false)}>Try again</Button>
    </div>
  {:else}
    {#key allow}
      <iframe bind:this={frame} {title} sandbox="allow-scripts allow-forms" {allow} {srcdoc} class="h-full min-h-0 w-full flex-1 border-0 bg-transparent"></iframe>
    {/key}
  {/if}
  <div class="absolute top-1.5 right-1.5 flex gap-1">
    <Button
      variant="outline"
      size="icon"
      aria-label={isFullscreen ? "Exit full screen" : "Open app full screen"}
      class="rounded-full bg-card/80 text-muted-foreground pointer-coarse:tap-area"
      onclick={() => setFullscreen(!isFullscreen)}
    >
      {#if isFullscreen}<Minimize size={13} />{:else}<Maximize size={13} />{/if}
    </Button>
    <Button
      variant="outline"
      size="icon"
      aria-label="Close app"
      class="rounded-full bg-card/80 text-muted-foreground pointer-coarse:tap-area"
      onclick={() => (host ? void host.close() : close())}
    >
      <X size={13} />
    </Button>
  </div>
</dialog>

{#if requestedPermissions.length}
  <div class="mb-2 flex min-h-11 items-center gap-2 text-workspace-chrome text-muted-foreground">
    <Shield size={16} class="shrink-0" />
    <span class="min-w-0 flex-1 truncate">This app asks for {mcpAppPermissionLabel(requestedPermissions)}</span>
    <Button variant="ghost" class="shrink-0 pointer-coarse:h-11" onclick={grantPermissions}>Review…</Button>
  </div>
{/if}
{#if modelContext}
  <div class="mb-2 text-workspace-chrome text-muted-foreground">
    <button
      type="button"
      aria-expanded={isContextOpen}
      class="flex min-h-11 items-center gap-2 hover:text-foreground"
      onclick={() => (isContextOpen = !isContextOpen)}
    >
      <Bot size={16} class="shrink-0" />
      <span>Context shared with the agent</span>
      {#if isContextOpen}<ChevronDown size={16} />{:else}<ChevronRight size={16} />{/if}
    </button>
    {#if isContextOpen}
      <p class="mb-1">The agent gets this with each new turn of this session.</p>
      <pre class="max-h-60 overflow-auto rounded-lg border border-border p-3 font-mono text-xs whitespace-pre-wrap text-foreground">{modelContext}</pre>
    {/if}
  </div>
{/if}

<dialog
  bind:this={confirmDialog}
  oncancel={() => decide(false)}
  class="m-auto max-h-[80dvh] w-full max-w-120 rounded-2xl border border-border bg-popover p-5 text-popover-foreground shadow-xl backdrop:modal-backdrop"
>
  {#if confirmation}
    <h2 class="text-base font-semibold">{confirmation.title}</h2>
    {#if confirmation.format === "arguments"}
      <pre class="my-4 max-h-80 overflow-auto rounded-lg border border-border p-3 font-mono text-xs whitespace-pre-wrap break-words">{confirmation.detail}</pre>
    {:else}
      <p class="my-4 max-h-80 overflow-auto text-sm whitespace-pre-wrap break-words">{confirmation.detail}</p>
    {/if}
    <div class="flex justify-end gap-2">
      <Button variant="outline" class="pointer-coarse:h-11" onclick={() => decide(false)}>Cancel</Button>
      <Button class="pointer-coarse:h-11" onclick={() => decide(true)}>Allow</Button>
    </div>
  {/if}
</dialog>
