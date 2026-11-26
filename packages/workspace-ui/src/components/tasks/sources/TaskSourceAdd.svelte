<script lang="ts">
  import { Plus as PlusIcon } from "@lucide/svelte";
  import { untrack } from "svelte";
  import type { issueSourceProvider } from "@solus/contracts/task-sources";
  import { connectionsStore, getSurfaceContext, taskHostId, issueSourcesStore } from "../../../contexts";
  import { atlassianStore } from "../../../contexts/atlassian/atlassian.store.svelte";
  import AtlassianConnectForm from "../../atlassian/AtlassianConnectForm.svelte";
  import GitHubConnectForm from "../../connections/GitHubConnectForm.svelte";
  import IntegrationDialog from "../../settings/IntegrationDialog.svelte";
  import { PROVIDER_LOGOS } from "../../settings/lib/provider-logos";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import * as Popover from "../../ui/popover";
  import { SourceLogo } from "../../ui/list-page";
  import { MenuLinearKey } from "./lib/menu-linear-key.svelte";
  import TaskSourcePicker from "./TaskSourcePicker.svelte";

  /**
   * Opens the menu that adds a task source (docs/tasks.md). Two looks. On the
   * strip of sources it is the quiet last chip. On the first-source setup it is
   * one card for each provider, and the menu opens on that provider's
   * choices. The menu stays open after an add, so a person adds several. Every
   * card looks the same; one whose provider is not connected opens the dialog
   * Settings uses to connect it, and then its menu. The menu's footer opens
   * the same dialogs on both looks.
   */
  interface Props {
    look: "strip" | "providers";
    /** Called after a source is added, so the page reads its tasks again. */
    onChanged?: () => void;
  }
  let { look, onChanged }: Props = $props();

  type SourceProvider = ReturnType<typeof issueSourceProvider>;
  const PROVIDERS: { id: SourceProvider; label: string; detail: string }[] = [
    { id: "github", label: "GitHub", detail: "Repositories and Projects" },
    { id: "jira", label: "Jira", detail: "Projects and boards" },
    { id: "linear", label: "Linear", detail: "Teams" },
  ];

  let open = $state(false);
  /** The provider button that opened the menu, and whose choices it shows. */
  let provider = $state<SourceProvider | null>(null);
  let providerButton = $state<HTMLElement | null>(null);

  function openFor(shown: SourceProvider, button: HTMLElement) {
    providerButton = button;
    provider = shown;
    open = true;
  }

  // ── Connecting a provider from its card ──
  const serverId = $derived(taskHostId());
  const options = $derived(issueSourcesStore.options);
  // The connections as Settings reads them: quick, so a card opens the
  // connect dialog before the providers have listed any choice. The choices answer only
  // while a connection has not.
  let connecting = $state<SourceProvider | null>(null);
  const surface = getSurfaceContext();
  const linearKey = $derived(serverId && (look === "providers" || connecting === "linear") ? new MenuLinearKey(serverId) : null);
  $effect(() => {
    if (serverId && (look === "providers" || connecting === "jira")) untrack(() => void atlassianStore.ensureStatus(serverId));
  });
  $effect(() => {
    const key = linearKey;
    if (!key) return;
    const stop = key.watch();
    untrack(() => void key.connection.load());
    return stop;
  });
  /** Whether the provider cannot list a choice until it is connected. GitHub
   *  connects through its menu, which says how. */
  function needsConnecting(shown: SourceProvider): boolean {
    if (shown === "jira") {
      if (serverId && atlassianStore.statusLoaded(serverId)) {
        return !atlassianStore.connected(serverId) || !atlassianStore.status(serverId)?.products?.includes("jira");
      }
      return !!options && (!options.jira.connected || !options.jira.cloudId);
    }
    if (shown === "linear") {
      if (linearKey && linearKey.state.location !== null) return !linearKey.state.connected;
      return !!options?.linear && !options.linear.connected;
    }
    return false;
  }
  const cards: Partial<Record<SourceProvider, HTMLElement>> = {};

  function choose(shown: SourceProvider, button: HTMLElement) {
    if ((shown === "jira" || shown === "linear") && needsConnecting(shown)) connecting = shown;
    else openFor(shown, button);
  }

  // The menu's footer closes the menu and opens the dialog in its place.
  function connectFromMenu(shown: SourceProvider) {
    open = false;
    connecting = shown;
  }

  // Connected: the choices are read again, and the menu opens on them.
  async function connected(shown: SourceProvider) {
    connecting = null;
    if (shown === "jira" && serverId) void atlassianStore.refreshStatus(serverId);
    await issueSourcesStore.loadOptions();
    const card = cards[shown];
    if (card) openFor(shown, card);
    else open = true;
  }

  // A GitHub device sign-in polls until it ends, so closing the dialog stops it.
  function closeGitHub(host: string) {
    connecting = null;
    if (connectionsStore.providerConnecting) void connectionsStore.cancelProviderConnect(host, surface.ctx);
  }

  // A browser sign-in in flight holds a loopback port on the host, so closing
  // the dialog releases it, as Settings does.
  function closeJira(host: string) {
    connecting = null;
    if (atlassianStore.awaitingBrowser(host)) void atlassianStore.cancelBrowserWait(host);
    atlassianStore.clearFailure(host);
  }

  // Linear takes a personal key, saved where Settings › Integrations saves it.
  let linearDraft = $state("");
  async function saveLinearKey(event: SubmitEvent) {
    event.preventDefault();
    const draft = linearDraft;
    linearDraft = "";
    if (linearKey && (await linearKey.connection.save(draft))) void connected("linear");
  }
</script>

{#if look === "providers"}
  <!-- The menu anchors to the card that opened it, so these are plain buttons
       rather than one trigger. The cards are the setup's own cards. -->
  <div class="grid grid-cols-1 gap-2 @min-[40rem]/pane:grid-cols-3" role="group" aria-label="Add an issue source">
    {#each PROVIDERS as shown (shown.id)}
      <button
        bind:this={cards[shown.id]}
        type="button"
        class="flex min-w-0 cursor-pointer items-center gap-3 overflow-hidden rounded-xl border-0 bg-card py-3 pr-3 pl-2.5 text-left shadow-[inset_0_0_0_0.5px_var(--hairline-strong)] transition-colors duration-150 hover:bg-[var(--wash-1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] aria-expanded:bg-[var(--wash-1)]"
        aria-haspopup="dialog"
        aria-expanded={(open && provider === shown.id) || connecting === shown.id}
        onclick={(event) => choose(shown.id, event.currentTarget)}
      >
        <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--wash-2)]" aria-hidden="true">
          <SourceLogo source={shown.id} />
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-workspace-chrome leading-5 font-medium text-foreground">{shown.label}</span>
          <span class="truncate text-xs leading-4 text-muted-foreground">{shown.detail}</span>
        </span>
        <PlusIcon size={16} class="shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    {/each}
  </div>
{/if}

{#if serverId && surface.workspace}
  <IntegrationDialog
    isOpen={connecting === "github"}
    title={options?.github.connected ? "Connect GitHub again" : "Connect GitHub"}
    description={options?.github.connected
      ? "Sign in again to let Solus read your GitHub Projects."
      : "Sign in with a code, then pick the repositories and Projects your issues come from."}
    logo={PROVIDER_LOGOS.github}
    onClose={() => closeGitHub(serverId)}
  >
    <GitHubConnectForm {serverId} onconnected={() => void connected("github")} />
  </IntegrationDialog>
{/if}

{#if serverId}
  <IntegrationDialog
    isOpen={connecting === "jira"}
    title="Connect Jira"
    description="Sign in to your Atlassian site, then pick the Jira projects and boards your issues come from."
    logo={PROVIDER_LOGOS.atlassian}
    onClose={() => closeJira(serverId)}
  >
    <AtlassianConnectForm {serverId} onconnected={() => void connected("jira")} />
  </IntegrationDialog>
  <IntegrationDialog
    isOpen={connecting === "linear"}
    title="Connect Linear"
    description="Paste a personal API key, then pick the Linear teams your issues come from."
    logo={PROVIDER_LOGOS.linear}
    onClose={() => { connecting = null; linearDraft = ""; }}
  >
    <form class="flex flex-col gap-4" onsubmit={saveLinearKey}>
      <div class="flex flex-col gap-1">
        <label for="setup-linear-key" class="text-xs font-medium text-foreground">API key</label>
        <Input id="setup-linear-key" type="password" bind:value={linearDraft} autocomplete="new-password" maxlength={4096}
          placeholder="lin_api_…" disabled={linearKey?.state.pending} class="text-workspace-chrome" />
        <a href="https://linear.app/settings/account/security" target="_blank" rel="noreferrer"
          class="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Create a key in Linear Settings → Security &amp; access</a>
      </div>
      {#if linearKey?.state.error}<p role="alert" class="m-0 text-pretty text-xs text-(--solus-status-error)">{linearKey.state.error}</p>{/if}
      <div>
        <Button type="submit" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={!linearDraft.trim() || !!linearKey?.state.pending}>
          {linearKey?.state.pending ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </form>
  </IntegrationDialog>
{/if}

<Popover.Root bind:open onOpenChange={(isOpen) => { if (!isOpen) provider = null; }}>
  {#if look === "strip"}
    <Popover.Trigger>
      {#snippet child({ props })}
        <!-- The last chip of the strip, in the chips' own geometry. The label
             goes first in a narrow pane; the plus and the title carry it. -->
        <button
          {...props}
          type="button"
          class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border-0 bg-transparent px-2 text-workspace-chrome text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-9"
          aria-label="Add an issue source"
          title="Add a GitHub repository or Project, a Jira project or board, or a Linear team."
        >
          <PlusIcon size={16} class="shrink-0" aria-hidden="true" />
          <span class="truncate @max-[30rem]/pane:hidden">Add source</span>
        </button>
      {/snippet}
    </Popover.Trigger>
  {/if}
  <Popover.Content
    data-solus-ui
    side="bottom"
    align="start"
    sideOffset={6}
    collisionPadding={8}
    customAnchor={look === "providers" ? providerButton : undefined}
    onCloseAutoFocus={(event) => { if (connecting) event.preventDefault(); }}
    class="menu-surface z-[10002] w-[min(24rem,calc(100vw-2rem))] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0"
  >
    <TaskSourcePicker active={open} {provider} {onChanged} onLeave={() => (open = false)} onConnect={connectFromMenu} />
  </Popover.Content>
</Popover.Root>
