<script lang="ts">
  import WorkHeaderActions from "../work/WorkHeaderActions.svelte";
  import ParentPageCrumb from "../ui/list-page/ParentPageCrumb.svelte";
  import SessionNameInput from "../session/SessionNameInput.svelte";
  import McpAppFrame from "../conversation/McpAppFrame.svelte";
  import * as Select from "../ui/select";
  import { Button } from "../ui/button";
  import { RotateCw as ReloadIcon, Plug as ConnectIcon, ShieldCheck as HostAccessIcon } from "@lucide/svelte";
  import { appHostAccessNotice, appSourceText, parseAppBundle } from "@solus/contracts/apps";
  import { serverConnections } from "@solus/client-core/server-connections";
  import type { FilePayload, WorkExportFormat, WorkExportRequest } from "../work/lib/work-export";
  import { getSurfaceContext } from "../../contexts";
  import { appsStore } from "./apps.store.svelte";
  import { TOOL_CHOICES, WRITE_CHOICES, toolsChoiceLabel, toolsChoiceOf, withToolsChoice, withWritesChoice, writesChoiceLabel } from "./lib/app-permissions";

  /**
   * The pane surface for an `app` work (docs/plans/apps.md §9): the works
   * header, the app's permissions, connect state, and host access, and the
   * MCP App frame over the document the host composed. The frame's calls name
   * the work; the host checks each one on every call.
   */
  interface Props {
    content: string;
    title: string;
    workId: string;
    onClose: () => void;
    onRename?: (title: string) => void;
    onDelete?: () => void;
    onDuplicate?: () => void | Promise<void>;
    onExport?: (request: WorkExportRequest) => void;
    hostIsRemote?: boolean;
    onOpenWorkspace?: () => void;
  }

  let { content, title, workId, onClose, onRename, onDelete, onDuplicate, onExport, hostIsRemote = false, onOpenWorkspace }: Props = $props();

  const session = getSurfaceContext();
  const serverId = $derived(session.worksStore.hostFor(workId));
  const api = $derived(serverId ? serverConnections.apiFor(serverId) : null);
  const saved = $derived(session.worksStore.savedWork(workId));
  const read = $derived(appsStore.read(workId));
  const snapshot = $derived(read.phase === "ready" ? read.snapshot : null);
  const missingRoles = $derived(snapshot?.roles.filter((role) => !role.connected) ?? []);
  const hostAccessNotice = $derived(snapshot ? appHostAccessNotice(snapshot.hostAccess) : null);
  // Renaming and changing permissions are the same right: the owner's or an editor's.
  const canChangePermissions = $derived(!!onRename && !!api);

  // A newer saved body is a new document: the store reads again for it.
  $effect(() => {
    if (api) void appsStore.load(api, workId, saved?.contentVersion);
  });

  const calls = $derived({
    toolInfo: async (name: string) => {
      if (!api) throw new Error("This app's host is not connected.");
      return api.appToolInfo({ workId, name });
    },
    callTool: async (name: string, argumentsJson: string, approved: boolean) => {
      if (!api) throw new Error("This app's host is not connected.");
      return api.appCallTool({ workId, name, argumentsJson, approved });
    },
    readResource: async () => {
      throw new Error("An app has no resources to read.");
    },
  });

  let renaming = $state(false);
  let copied = $state(false);
  function copySource() {
    void navigator.clipboard.writeText(appSourceText(content)).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1500);
    });
  }

  const sourcePayload = (): FilePayload | null => (content.trim() ? { contents: content, encoding: "utf8" } : null);
  // A component saves as its source; a bundle saves as the file an app project built.
  const exportFormats: WorkExportFormat[] = $derived(
    parseAppBundle(content)
      ? [{ extension: "json", label: "App bundle", mimeType: "application/json", produce: sourcePayload }]
      : [{ extension: "tsx", label: "Component source", mimeType: "text/plain", produce: sourcePayload }],
  );

  /** Bumping this re-creates the frame: the only way to restart an app. */
  let frameKey = $state(0);
  function reload() {
    if (!api) return;
    frameKey += 1;
    void appsStore.reload(api, workId);
  }

  /** The frame's height is the app's own; the pane scrolls past it. */
  let frameHeight = $state(360);
</script>

<div class="flex h-full min-h-0 flex-col bg-(--solus-container-bg)" data-testid="app-shell">
  <div
    class="flex h-auto min-h-[var(--solus-chrome-row-h,2.5rem)] shrink-0 items-center gap-1.5 pl-[max(1rem,var(--solus-chrome-lead-inset,0px))] pr-[max(1rem,var(--solus-pane-chrome-inset,0px))] @max-[30rem]/pane:flex-wrap @max-[30rem]/pane:gap-1 @max-[30rem]/pane:pl-2"
  >
    {#if onOpenWorkspace}
      <span class="-ml-[7px] flex shrink-0 items-center @max-[30rem]/pane:ml-0">
        <ParentPageCrumb page="folio" onOpen={onOpenWorkspace} />
      </span>
    {/if}
    {#if renaming}
      <span class="flex h-[1.875rem] w-80 min-w-24 max-w-full flex-1 items-center">
        <SessionNameInput
          value={title}
          variant="row"
          class="text-workspace-chrome font-medium"
          onCommit={(next) => {
            renaming = false;
            onRename?.(next);
          }}
          onCancel={() => (renaming = false)}
        />
      </span>
    {:else}
      <button
        type="button"
        class="min-w-0 flex-1 truncate border-0 bg-transparent text-left text-workspace-chrome font-medium text-(--solus-text-primary)"
        ondblclick={() => onRename && (renaming = true)}
        disabled={!onRename}
        title={onRename ? "Double-click to rename" : undefined}
        data-testid="app-shell-title"
      >
        {title}
      </button>
    {/if}
    {#if snapshot}
      <Select.Root
        type="single"
        value={toolsChoiceOf(snapshot.permissions)}
        disabled={!canChangePermissions}
        onValueChange={(next) => api && void appsStore.setPermissions(api, workId, withToolsChoice(snapshot.permissions, next))}
      >
        <Select.Trigger
          aria-label="Tools the app may call"
          title="Tools the app may call"
          size="sm"
          data-testid="app-shell-tools-permission"
          class="h-[1.625rem] shrink-0 rounded-full px-2.5 text-workspace-chrome pointer-coarse:h-10 @max-[30rem]/pane:order-last"
        >
          {toolsChoiceLabel(snapshot.permissions)}
        </Select.Trigger>
        <Select.Content side="bottom" align="end" sideOffset={5} class="z-[10002] w-[min(13rem,calc(100vw-2rem))]">
          {#each TOOL_CHOICES as choice (choice.value)}
            <Select.Item value={choice.value} label={choice.label} class="text-workspace-chrome" />
          {/each}
        </Select.Content>
      </Select.Root>
      <Select.Root
        type="single"
        value={snapshot.permissions.writes}
        disabled={!canChangePermissions}
        onValueChange={(next) => api && void appsStore.setPermissions(api, workId, withWritesChoice(snapshot.permissions, next))}
      >
        <Select.Trigger
          aria-label="What a write does"
          title="What a write does"
          size="sm"
          data-testid="app-shell-writes-permission"
          class="h-[1.625rem] shrink-0 rounded-full px-2.5 text-workspace-chrome pointer-coarse:h-10 @max-[30rem]/pane:order-last"
        >
          {writesChoiceLabel(snapshot.permissions)}
        </Select.Trigger>
        <Select.Content side="bottom" align="end" sideOffset={5} class="z-[10002] w-[min(13rem,calc(100vw-2rem))]">
          {#each WRITE_CHOICES as choice (choice.value)}
            <Select.Item value={choice.value} label={choice.label} class="text-workspace-chrome" />
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}
    <Button
      variant="ghost"
      size="icon-sm"
      class="size-[1.625rem] shrink-0 rounded-full pointer-coarse:size-10"
      title="Reload the app"
      aria-label="Reload the app"
      data-testid="app-shell-reload"
      disabled={!api}
      onclick={reload}
    >
      <ReloadIcon size={15} strokeWidth={1.5} />
    </Button>
    <WorkHeaderActions
      onStartRename={onRename ? () => (renaming = true) : undefined}
      {copied}
      copy={copySource}
      {workId}
      {title}
      currentContent={content}
      {exportFormats}
      {onExport}
      {hostIsRemote}
      {onDelete}
      {onDuplicate}
    />
  </div>

  {#if missingRoles.length > 0}
    <div class="flex min-h-11 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-workspace-chrome text-muted-foreground" role="status" data-testid="app-shell-connect">
      <ConnectIcon size={14} class="shrink-0" />
      <span class="min-w-0 flex-1">
        This app uses {missingRoles.map((role) => role.name ?? role.slug).join(", ")} with your own account. Connect {missingRoles.length === 1 ? "it" : "them"}, then reload the app.
      </span>
      {#if session.workspace}
        <Button variant="outline" size="sm" class="shrink-0 rounded-full text-workspace-chrome pointer-coarse:h-10" onclick={() => session.workspace?.showSettings("mcp")}>
          Open Settings → MCP
        </Button>
      {/if}
    </div>
  {/if}

  {#if snapshot && hostAccessNotice}
    <div class="flex min-h-11 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-workspace-chrome text-muted-foreground" role="status" data-testid="app-shell-host-access">
      <HostAccessIcon size={14} class="shrink-0" />
      <span class="min-w-0 flex-1">{hostAccessNotice}</span>
      {#if snapshot.hostAccess.canDecide && api}
        {#if snapshot.hostAccess.state === "pending"}
          <Button size="sm" class="shrink-0 rounded-full text-workspace-chrome pointer-coarse:h-10" data-testid="app-shell-host-access-allow" onclick={() => void appsStore.decideHostAccess(api, workId, true)}>
            Allow
          </Button>
        {:else}
          <Button variant="outline" size="sm" class="shrink-0 rounded-full text-workspace-chrome pointer-coarse:h-10" data-testid="app-shell-host-access-revoke" onclick={() => void appsStore.decideHostAccess(api, workId, false)}>
            Revoke
          </Button>
        {/if}
      {/if}
    </div>
  {/if}

  <div class="min-h-0 flex-1 overflow-auto p-4" data-testid="app-shell-body">
    {#if !api}
      <div class="flex min-h-40 items-center justify-center text-sm text-muted-foreground" role="status">This app's host is not connected.</div>
    {:else if read.phase === "error"}
      <div class="flex min-h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground" role="alert">
        <span>{read.message}</span>
        <Button variant="ghost" size="sm" class="pointer-coarse:h-10" onclick={reload}>Try again</Button>
      </div>
    {:else if snapshot}
      <!-- A host access decision changes the document's policy, so it is a new frame. -->
      {#key `${workId}-${snapshot.contentVersion}-${snapshot.hostAccess.state}-${frameKey}`}
        <McpAppFrame
          snapshot={{ html: snapshot.html, csp: snapshot.csp, toolInputJson: "{}", toolResultJson: "{}" }}
          {calls}
          {title}
          onSend={() => false}
          initialHeight={frameHeight}
          onHeight={(height) => (frameHeight = height)}
          {onClose}
        />
      {/key}
    {:else}
      <div class="flex min-h-40 items-center justify-center text-sm text-muted-foreground" role="status">Loading app…</div>
    {/if}
  </div>
</div>
