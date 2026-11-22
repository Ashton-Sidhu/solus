<script lang="ts">
  /**
   * One server on this host that Solus does not have (docs/plans/mcp-first-class.md
   * §8.6, §8.8), drawn as a catalog row: the icon, the name with the logo of
   * each tool whose config file has it, the command or URL on one line, and
   * Add or Review change. Its menu tests it (starts it once and lists its
   * tools below the row), turns it off or on for a tool, opens a file, and
   * deletes it from a file after a question. A server Solus cannot add says why
   * in place of its command. The add dialog shows the full command, the files,
   * and every warning before anything runs.
   */
  import { Ellipsis, FlaskConical, LoaderCircle, X } from "@lucide/svelte";
  import type { FoundPlace, FoundServer, IntegrationFoundChange } from "@solus/contracts/integration-types";
  import { FoundServerLabels, foundDeleteQuestion, type FoundFileAction } from "@solus/contracts/integrations/found-server-labels";
  import type { FoundTest } from "../../contexts/mcp";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import McpConfirmPopover from "./McpConfirmPopover.svelte";
  import McpFoundFileItems from "./McpFoundFileItems.svelte";
  import McpFoundSourceLogo from "./McpFoundSourceLogo.svelte";
  import McpServerIcon from "./McpServerIcon.svelte";
  import { MiddleTruncate } from "../ui/middle-truncate";

  interface Props {
    server: FoundServer;
    /** The host whose loopback a running server is on. */
    hostLabel: string;
    isOffline: boolean;
    isAdding: boolean;
    isChanging: boolean;
    /** A host administrator: a test runs a command, and a change edits a file of the host's user. */
    mayChange: boolean;
    canOpenFiles: boolean;
    test: FoundTest | undefined;
    onReview: (server: FoundServer) => void;
    onTest: (server: FoundServer) => void;
    onCloseTest: (server: FoundServer) => void;
    onOpen: (place: FoundPlace) => void;
    /** The error's words, or null when the file changed. */
    onChange: (server: FoundServer, place: FoundPlace, change: IntegrationFoundChange) => Promise<string | null>;
  }
  let { server, hostLabel, isOffline, isAdding, isChanging, mayChange, canOpenFiles, test, onReview, onTest, onCloseTest, onOpen, onChange }: Props = $props();

  const labels = $derived(new FoundServerLabels(server, hostLabel));
  const url = $derived(server.transport && server.transport.kind !== "stdio" ? server.transport.url : "");
  const detail = $derived(labels.unsupported ?? labels.target);
  const canTest = $derived(mayChange && server.state !== "unsupported");
  let menuTriggerEl = $state<HTMLElement | null>(null);
  let deleting = $state<FoundFileAction | null>(null);
  let isConfirming = $state(false);
  let changeError = $state("");

  /** A delete asks first, once the menu has closed and handed focus back; a turn off or on runs at once. */
  async function act(action: FoundFileAction) {
    changeError = "";
    if (action.change === "delete") {
      deleting = action;
      requestAnimationFrame(() => { isConfirming = true; });
      return;
    }
    changeError = (await onChange(server, action.place, action.change)) ?? "";
  }

  async function confirmDelete() {
    if (!deleting) return;
    const error = await onChange(server, deleting.place, "delete");
    if (error) changeError = error;
    else isConfirming = false;
  }
</script>

<li class="flex min-w-0 flex-col py-3" data-testid="mcp-found-row" data-found-id={server.foundId}>
  <div class="flex min-w-0 items-center gap-3.5">
    <!-- A server Solus cannot add steps back, so the rows the person can act on lead. -->
    <div class="flex min-w-0 flex-1 items-center gap-3.5 {server.state === 'unsupported' ? 'opacity-55' : ''}">
      <McpServerIcon name={server.name} {url} />
      <div class="min-w-0 flex-1">
        <p class="flex min-w-0 items-center gap-1.5 text-workspace-chrome leading-5 font-medium text-foreground">
          <span class="truncate" title={server.name}>{server.name}</span>
          {#each labels.sources as source (source.label)}<McpFoundSourceLogo {source} />{/each}
        </p>
        {#if labels.unsupported}
          <p class="truncate text-chrome-dense leading-5 text-muted-foreground" title={detail}>{detail}</p>
        {:else}
          <!-- A command keeps its end in view: the program and its arguments say more than the folders before them. -->
          <MiddleTruncate value={detail} class="flex text-chrome-dense leading-5 font-mono text-muted-foreground" />
        {/if}
      </div>
    </div>
    <!-- The row's actions sit together, apart from its text. -->
    <div class="flex shrink-0 items-center gap-1">
      {#if server.state === "new" || server.state === "changed"}
        <Button variant="outline" size="sm" class="shrink-0 text-workspace-chrome pointer-coarse:min-h-11" disabled={isOffline || isAdding}
          onclick={() => onReview(server)} aria-label={server.state === "new" ? `Add ${server.name}` : `Review the change of ${server.name}`}>
          {server.state === "new" ? "Add" : "Review change"}
        </Button>
      {:else}
        <span class="shrink-0 text-chrome-dense text-muted-foreground">{labels.state}</span>
      {/if}
      {#if mayChange}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} bind:ref={menuTriggerEl} variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:tap-area" disabled={isOffline || isChanging} aria-label="More actions for {server.name}">
                {#if isChanging}<LoaderCircle size={16} class="animate-spin motion-reduce:animate-none" />{:else}<Ellipsis size={16} />{/if}
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[min(18rem,calc(100vw-2rem))]">
            <DropdownMenu.Item disabled={!canTest || test?.kind === "running"} onSelect={() => onTest(server)}><FlaskConical size={14} />Test and show tools</DropdownMenu.Item>
            <McpFoundFileItems {server} showTurnOff {canOpenFiles} {onOpen} onAction={act} />
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <McpConfirmPopover bind:open={isConfirming} anchor={menuTriggerEl} title="{deleting?.label ?? 'Delete'}?"
          text={deleting ? foundDeleteQuestion(server.name, deleting.place) : ""} action="Delete" busyAction="Deleting…"
          isBusy={isChanging} error={changeError} onConfirm={confirmDelete} />
      {/if}
    </div>
  </div>
  {#if changeError && !isConfirming}
    <p role="alert" class="pt-2 pl-[46px] text-chrome-dense text-(--solus-status-error)">{changeError}</p>
  {/if}
  {#if test}
    <!-- What a test found: the tools an agent would get, under the row's text column. -->
    <div class="mt-2 ml-[46px] flex min-w-0 flex-col gap-1.5 rounded-lg bg-muted/60 px-3 py-2.5" aria-live="polite">
      <div class="flex items-center justify-between gap-3">
        <p class="text-chrome-dense font-medium text-(--solus-text-secondary)">
          {#if test.kind === "running"}Starting {server.name} to read its tools…{:else if test.kind === "failed"}The test failed{:else}{test.tools.length} {test.tools.length === 1 ? "tool" : "tools"}{/if}
        </p>
        <Button variant="ghost" size="icon-sm" class="-my-1 shrink-0 text-muted-foreground" onclick={() => onCloseTest(server)} aria-label="Close the test of {server.name}"><X size={14} /></Button>
      </div>
      {#if test.kind === "failed"}
        <p role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{test.message}</p>
      {:else if test.kind === "tools"}
        <ul class="flex flex-col gap-1">
          {#each test.tools as tool (tool.name)}
            <li class="flex min-w-0 items-baseline gap-2 text-chrome-dense">
              <span class="shrink-0 font-mono text-foreground">{tool.name}</span>
              <span class="truncate text-muted-foreground" title={tool.description}>{tool.description}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</li>
