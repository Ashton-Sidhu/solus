<script lang="ts">
  import { tick, untrack } from "svelte";
  import { ArrowLeftRight, Bot, ChevronDown, ChevronRight, Maximize, Minimize, Minimize2, PictureInPicture2, Shield, X } from "@lucide/svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { localApi } from "@solus/client-core/local-api";
  import { MCP_APP_PIP_MIN_CONVERSATION_WIDTH, mcpAppAvailableDisplayModes, type McpAppDisplayMode } from "@solus/client-core/mcp-app-context";
  import { mcpAppFrameHeight } from "@solus/client-core/mcp-app-document";
  import { mcpAppOffersDisplayMode, type McpAppConfirmFormat, type McpAppHost, type McpAppLiveCall } from "@solus/client-core/mcp-app-host";
  import { mcpAppAllowAttribute, mcpAppPermissionAction, mcpAppPermissionPrompt, mcpAppPermissionRequest } from "@solus/client-core/mcp-app-permissions";
  import { mcpAppDocument, type McpAppCancelReason, type McpAppLiveDocument, type McpAppPermission, type McpAppRequest, type McpAppSnapshot } from "@solus/contracts/mcp-apps";
  import { Button } from "../ui/button";
  import { getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { connectMcpAppFrame, mcpAppContext, mcpAppSupportedPermissions, mcpAppTurnKey } from "./lib/mcp-app-frame";

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
    /** The conversation keeps this app in picture-in-picture (`ConversationViewState.mcpAppPip`). */
    isPip: boolean;
    /** With the card's turn to keep this app in picture-in-picture; null to give it back to its card. */
    onPip: (turnKey: string | null) => void;
    /** The lower corner the frame sits in while in picture-in-picture. */
    pipSide: "end" | "start";
    onMovePip: () => void;
  }

  let { snapshot, call, savedCall, api, request, title, onSend, onClose, initialHeight = 320, onHeight, modelContext, onModelContext, permissions, onPermissions, isPip, onPip, pipSide, onMovePip }: Props = $props();

  const settings = getSettingsContext();
  const srcdoc = $derived(mcpAppDocument(snapshot.html, snapshot.csp));
  const allow = $derived(mcpAppAllowAttribute(permissions));
  const requestedPermissions = $derived(mcpAppPermissionRequest(snapshot.permissions, mcpAppSupportedPermissions()).filter((permission) => !permissions.includes(permission)));
  let isContextOpen = $state(false);
  let frame = $state<HTMLIFrameElement | null>(null);
  let appDialog = $state<HTMLDialogElement | null>(null);
  let confirmDialog = $state<HTMLDialogElement | null>(null);
  let cancelButton = $state<HTMLButtonElement | null>(null);
  let isFullscreen = $state(false);
  const displayMode: McpAppDisplayMode = $derived(isFullscreen ? "fullscreen" : isPip ? "pip" : "inline");
  // Measured on the conversation; zero outside one, where nothing can float.
  let conversationWidth = $state(0);
  const fitsPip = $derived(conversationWidth >= MCP_APP_PIP_MIN_CONVERSATION_WIDTH);
  const availableModes = $derived(mcpAppAvailableDisplayModes({ conversationWidth }));
  let declaredModes = $state.raw<readonly McpAppDisplayMode[] | null>(null);
  const offersPip = $derived(mcpAppOffersDisplayMode("pip", availableModes, declaredModes));
  const offersFullscreen = $derived(mcpAppOffersDisplayMode("fullscreen", availableModes, declaredModes));
  let failed = $state(false);
  let height = $state(untrack(() => initialHeight));
  let confirmation = $state<{ title: string; detail: string; format: McpAppConfirmFormat; resolve: (allowed: boolean) => void } | null>(null);
  let host = $state.raw<McpAppHost | null>(null);

  /** One approval at a time: a request while another waits is refused. */
  function confirm(title: string, detail: string, format: McpAppConfirmFormat): Promise<boolean> {
    if (confirmation) return Promise.resolve(false);
    return new Promise((resolve) => {
      confirmation = { title, detail, format, resolve };
      // Open once the buttons render: a dialog with no control yet takes the focus and its ring itself.
      void tick().then(() => {
        confirmDialog?.showModal();
        cancelButton?.focus();
      });
    });
  }

  function decide(allowed: boolean) {
    const pending = confirmation;
    confirmation = null;
    confirmDialog?.close();
    pending?.resolve(allowed);
  }

  /**
   * Every mode is the same dialog, so the frame never reloads: full screen is
   * the top layer, picture-in-picture is fixed over the conversation, and
   * inline is in the transcript. Answers the mode that results.
   */
  function setMode(next: McpAppDisplayMode): McpAppDisplayMode {
    const dialog = appDialog;
    if (!dialog || next === displayMode) return displayMode;
    const turnKey = next === "pip" ? mcpAppTurnKey(dialog) : undefined;
    if (next === "pip" && !turnKey) return displayMode;
    const wasFullscreen = isFullscreen;
    isFullscreen = next === "fullscreen";
    if (turnKey) onPip(turnKey);
    else if (isPip) onPip(null);
    if (wasFullscreen !== isFullscreen) {
      dialog.close();
      if (isFullscreen) dialog.showModal();
      else dialog.show();
    }
    return displayMode;
  }

  /** The person's controls; typing is what comes next, so the input bar gets the focus back. */
  function choose(next: McpAppDisplayMode) {
    setMode(next);
    requestInputFocus();
  }

  /** Back in its card, and the transcript shows the card. */
  async function returnToCard() {
    choose("inline");
    await tick();
    appDialog?.scrollIntoView({ block: "nearest" });
  }

  function close(cancelled?: McpAppCancelReason) {
    if (isPip) onPip(null);
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
      context: () => mcpAppContext(target, untrack(() => settings.isDark), untrack(() => displayMode), untrack(() => conversationWidth)),
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
      displayMode: setMode,
      declaredDisplayModes: (modes) => (declaredModes = modes),
      resize: (next) => {
        height = next;
        onHeight(next);
      },
      close,
    }, {
      onNavigated: () => {
        failed = true;
        setMode("inline");
      },
      displayMode: () => untrack(() => displayMode),
      onConversationWidth: (width) => {
        conversationWidth = width;
        if (width < MCP_APP_PIP_MIN_CONVERSATION_WIDTH && untrack(() => isPip)) setMode("inline");
      },
    });
    host = connection.host;
    return () => {
      connection.disconnect();
      host = null;
      decide(false);
    };
  });

  // The app hears each change of its context: the theme, its mode (another
  // app may have taken picture-in-picture), and whether it may float.
  $effect(() => {
    void settings.isDark;
    void displayMode;
    void fitsPip;
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
  data-mcp-app-mode={displayMode}
  oncancel={(event) => {
    event.preventDefault();
    choose("inline");
  }}
  class={isFullscreen
    ? "fixed inset-0 m-0 flex h-full max-h-none w-full max-w-none flex-col border-0 bg-background p-4 text-foreground"
    : isPip
      ? `fixed top-auto bottom-[calc(var(--solus-composer-height,0px)+3rem)] z-[6] m-0 flex h-[18.25rem] w-96 max-w-none flex-col overflow-hidden rounded-2xl border-0 bg-(--solus-popover-bg) p-0 text-foreground shadow-(--solus-popover-shadow) supports-[anchor-name:--a]:bottom-[calc(anchor(--solus-conversation_bottom)+var(--solus-composer-height,0px)+3rem)] ${pipSide === "end"
          ? "right-4 left-auto supports-[anchor-name:--a]:right-[calc(anchor(--solus-conversation_right)+1rem)]"
          : "right-auto left-4 supports-[anchor-name:--a]:left-[calc(anchor(--solus-conversation_left)+1rem)]"}`
      : snapshot.prefersBorder
        ? "relative mx-0 my-2 block w-full min-w-0 max-w-none overflow-hidden rounded-xl border border-(--solus-tool-border) bg-card p-0 text-foreground"
        : "relative mx-0 my-2 block w-full min-w-0 max-w-none border-0 bg-transparent p-0 text-foreground"}
  style:height={displayMode === "inline" ? `${mcpAppFrameHeight(height, snapshot.prefersBorder)}px` : undefined}
>
  {#if isFullscreen}
    <div class="flex min-h-11 items-center px-1 text-workspace-chrome font-medium">{title}</div>
  {:else if isPip}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="flex h-9 shrink-0 items-center gap-0.5 pr-1 pl-3 text-workspace-chrome font-medium"
      onkeydown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        void returnToCard();
      }}
    >
      <span class="min-w-0 flex-1 truncate">{title}</span>
      <Button variant="ghost" size="icon-sm" aria-label={pipSide === "end" ? "Move to the left" : "Move to the right"} class="text-muted-foreground pointer-coarse:tap-area" onclick={() => { onMovePip(); requestInputFocus(); }}>
        <ArrowLeftRight size={16} />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Return to card" class="text-muted-foreground pointer-coarse:tap-area" onclick={() => void returnToCard()}>
        <Minimize2 size={16} />
      </Button>
      {#if offersFullscreen}
        <Button variant="ghost" size="icon-sm" aria-label="Open app full screen" class="text-muted-foreground pointer-coarse:tap-area" onclick={() => choose("fullscreen")}>
          <Maximize size={16} />
        </Button>
      {/if}
      <Button variant="ghost" size="icon-sm" aria-label="Close app" class="text-muted-foreground pointer-coarse:tap-area" onclick={() => (host ? void host.close() : close())}>
        <X size={16} />
      </Button>
    </div>
  {/if}
  {#if failed}
    <div role="alert" class="flex h-full flex-col items-center justify-center gap-2 text-workspace-chrome text-muted-foreground">
      <span>This app could not be displayed.</span>
      <Button variant="ghost" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => (failed = false)}>Try again</Button>
    </div>
  {:else}
    {#key allow}
      <iframe bind:this={frame} {title} sandbox="allow-scripts allow-forms" {allow} {srcdoc} class="h-full min-h-0 w-full flex-1 border-0 bg-transparent"></iframe>
    {/key}
  {/if}
  <!-- The card's controls float over the app as one small toolbar: the
       popover surface with the menus' shadow, no outline, and the PiP
       header's ghost buttons. -->
  <div class="absolute top-2 right-2 flex items-center gap-0.5 rounded-full bg-(--solus-popover-bg) p-0.5 shadow-(--solus-menu-shadow)" hidden={isPip}>
    {#if offersPip && !isFullscreen}
      <Button variant="ghost" size="icon-sm" aria-label="Keep in view" class="rounded-full text-muted-foreground pointer-coarse:tap-area" onclick={() => choose("pip")}>
        <PictureInPicture2 size={16} />
      </Button>
    {/if}
    {#if offersFullscreen || isFullscreen}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={isFullscreen ? "Exit full screen" : "Open app full screen"}
        class="rounded-full text-muted-foreground pointer-coarse:tap-area"
        onclick={() => choose(isFullscreen ? "inline" : "fullscreen")}
      >
        {#if isFullscreen}<Minimize size={16} />{:else}<Maximize size={16} />{/if}
      </Button>
    {/if}
    <Button variant="ghost" size="icon-sm" aria-label="Close app" class="rounded-full text-muted-foreground pointer-coarse:tap-area" onclick={() => (host ? void host.close() : close())}>
      <X size={16} />
    </Button>
  </div>
</dialog>

{#if isPip}
  <!-- The card's place in the transcript while its frame floats over the conversation. -->
  <div class="my-2 flex min-h-11 items-center gap-2 text-workspace-chrome text-muted-foreground">
    <PictureInPicture2 size={16} class="shrink-0" />
    <span class="min-w-0 flex-1 truncate">The {title} app is in picture-in-picture</span>
    <Button variant="ghost" size="sm" class="shrink-0 text-workspace-chrome pointer-coarse:min-h-11" onclick={() => void returnToCard()}>Return to card</Button>
  </div>
{/if}
{#if requestedPermissions.length}
  <div class="mb-2 flex min-h-11 items-center gap-2 text-workspace-chrome text-muted-foreground">
    <Shield size={16} class="shrink-0" />
    <span class="min-w-0 flex-1 py-1 break-words">This app asks to {mcpAppPermissionAction(requestedPermissions)}</span>
    <Button variant="ghost" size="sm" class="shrink-0 text-workspace-chrome pointer-coarse:min-h-11" onclick={grantPermissions}>Review…</Button>
  </div>
{/if}
{#if modelContext}
  <div class="mb-2 text-workspace-chrome text-muted-foreground">
    <button
      type="button"
      aria-expanded={isContextOpen}
      class="flex min-h-11 items-center gap-2 rounded-md outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      onclick={() => (isContextOpen = !isContextOpen)}
    >
      <Bot size={16} class="shrink-0" />
      <span>Context shared with the agent</span>
      {#if isContextOpen}<ChevronDown size={16} />{:else}<ChevronRight size={16} />{/if}
    </button>
    {#if isContextOpen}
      <p class="mb-2">The agent gets this with each new turn of this session.</p>
      <pre class="m-0 max-h-60 overflow-auto rounded-[0.625rem] bg-(--solus-code-tint) p-3 font-mono text-transcript-meta whitespace-pre-wrap text-foreground">{modelContext}</pre>
    {/if}
  </div>
{/if}

<dialog
  bind:this={confirmDialog}
  oncancel={() => decide(false)}
  class="m-auto max-h-[80dvh] w-[min(30rem,calc(100vw-2rem))] max-w-none rounded-2xl border-0 bg-(--solus-popover-bg) p-6 text-workspace-chrome text-foreground shadow-(--solus-popover-shadow) outline-none backdrop:modal-backdrop"
>
  {#if confirmation}
    <h2 class="m-0 font-medium text-foreground">{confirmation.title}</h2>
    {#if confirmation.format === "arguments"}
      <pre class="mt-3 mb-5 max-h-80 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-chrome-dense whitespace-pre-wrap break-words text-foreground">{confirmation.detail}</pre>
    {:else}
      <p class="mt-2 mb-5 max-h-80 overflow-auto text-pretty whitespace-pre-wrap break-words text-(--solus-text-secondary)">{confirmation.detail}</p>
    {/if}
    <div class="flex justify-end gap-2">
      <Button bind:ref={cancelButton} variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => decide(false)}>Cancel</Button>
      <Button size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => decide(true)}>Allow</Button>
    </div>
  {/if}
</dialog>
