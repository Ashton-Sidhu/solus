<script lang="ts">
  import { GitPullRequestIcon } from "../ui/octicons";
  import { isSolusApiId } from "@solus/contracts/uplink";
  import { onDestroy, untrack, type Component } from "svelte";
  import { hostUpdatesStore } from "../../contexts/updates/host-updates.store.svelte";
  import {
    X as XIcon,
    ArrowLeft as ArrowLeftIcon,
    SlidersHorizontal as SlidersHorizontalIcon,
    Wrench as WrenchIcon,
    Sparkles as SparkleIcon,
    Monitor as HostsIcon,
    Keyboard as KeyboardIcon,
    Mic as MicrophoneIcon,
    Binoculars as BinocularsIcon,
    Cpu as ProvidersIcon,
    MessagesSquare as SessionsIcon,
    MessageSquareText as ChatIcon,
    Radio as BroadcastIcon,
    FlaskConical as FlaskIcon,
    ChevronDown as CaretDownIcon,
    Bell as BellIcon,
    Palette as PaletteIcon,
    Smartphone as SmartphoneIcon,
    UserRound as PersonIcon,
    Contact as AgentProfileIcon,
    Building2 as OrganizationIcon,
    ShieldCheck as PolicyIcon,
    Server as HostIcon,
    Plug as PlugIcon,
    Blocks as McpIcon,
    Webhook as WebhookIcon,
    FolderGit2 as CodebasesIcon,
    Share2 as SharingIcon,
  } from "@lucide/svelte";
  import {
    getWorkspaceContext,
    getClientShellContext,
    getSettingsContext,
    serversStore,
    agentProfileLocalStore,
    codebasesStore,
    accountStore,
  } from "../../contexts";
  import { settingsNavGroups, settingsTabShown, type SettingsNavGroup } from "./lib/settings-nav";
  import { NEW_CODEBASE } from "../codebases/lib/codebase-view";
  import type { SettingsTab } from "../../contexts/workspace/routing/route-registry";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import * as Breadcrumb from "../ui/breadcrumb";
  import { Button } from "../ui/button";
  import { PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";
  import { SearchField } from "../ui/search-field";
  import SettingsSections from "./SettingsSections.svelte";
  import SettingsUpdateButton from "./SettingsUpdateButton.svelte";
  import { mcpStore } from "../../contexts/mcp";
  import {
    mcpSearchWords as mcpSearch,
    analyticsSearchWords as analyticsSearch,
    accountSearchWords as accountSearch,
    agentProfileSearchWords as agentProfileSearch,
    hostSearchWords as hostSearch,
    organizationSearchWords as organizationSearch,
    policySearchWords as policySearch,
    webhooksSearchWords as webhooksSearch,
    codebasesSearchWords as codebasesSearch,
    sharingSearchWords as sharingSearch
  } from "./lib/settings-search-data";
  import { dataMatches, wordsMatch, settingsPageMatches, settingsPageQuery } from "./lib/settings-search";
  import RunOnPicker from "../servers/RunOnPicker.svelte";
  import { openFolder } from "../../contexts/workspace/run-location";
  import SettingsProjectScope from "./SettingsProjectScope.svelte";
  import { supportsProjectScope } from "./lib/settings-scope";
  import { agentProfileSearchWords } from "./agent-profile/lib/agent-profile-entries";
  import { settingsHost } from "./lib/settings-host.svelte";
  import { chosenSettingsHostId, settingsHostOrder } from "./lib/settings-hosts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as Sidebar from "../ui/sidebar";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { hosts } from "../../contexts/hosts/hosts.svelte";
  import { runHost } from "../../contexts/workspace/run-location";

  // The dialog owns the close, so it can play its exit animation first.
  let { onClose }: { onClose: () => void } = $props();

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  let searchQuery = $state("");

  function tabMatchesSearch(tab: TabMeta, query: string): boolean {
    return (
      settingsPageMatches(tab.id, query) ||
      wordsMatch(query, [tab.label, tab.description, ...(SEARCH_WORDS[tab.id] ?? [])]) ||
      (tab.id === "mcp" && wordsMatch(query, mcpStore.integrations.names())) ||
      (tab.id === "agent-profile" && wordsMatch(query, agentProfileSearchWords(agentProfileLocalStore.entries))) ||
      dataMatches(tab.id, query, settings.keybindings)
    );
  }

  // A search that leaves the open page empty opens the first page it matches.
  function setSearchQuery(query: string) {
    searchQuery = query;
    if (!query || searchedTabs.some((t) => t.id === session.settingsTab)) return;
    const first = searchedTabs[0];
    if (first) selectTab(first.id);
  }

  const shell = getClientShellContext();

  interface TabMeta {
    id: SettingsTab;
    label: string;
    /** One line of page copy — the single source for the content subtitle. */
    description: string;
    icon: Component<{ size?: number; class?: string }>;
    group: SettingsNavGroup;
    desktopOnly?: boolean;
  }

  // The groups and their order follow T3 Code's settings sidebar (lib/settings-nav.ts).
  const ALL_TABS: TabMeta[] = [
    {
      id: "general",
      label: "General",
      description: "Project folders, session names, your editor and terminal, and updates.",
      icon: SlidersHorizontalIcon,
      group: "Preferences",
    },
    {
      id: "appearance",
      label: "Appearance",
      description: "Theme, typefaces, and text sizes on this device.",
      icon: PaletteIcon,
      group: "Preferences",
    },
    {
      id: "chat",
      label: "Chat",
      description: "Responses, tool activity, and the input bar.",
      icon: ChatIcon,
      group: "Preferences",
    },
    {
      id: "notifications",
      label: "Notifications",
      description: "Which events notify you, and how.",
      icon: BellIcon,
      group: "Preferences",
    },
    {
      id: "keybindings",
      label: "Keybindings",
      description: "Rebind any shortcut. Saved on this device only.",
      icon: KeyboardIcon,
      group: "Preferences",
    },
    {
      id: "voice",
      label: "Voice",
      description: "Dictation, custom dictionary, and the voice model.",
      icon: MicrophoneIcon,
      group: "Preferences",
    },
    {
      id: "providers",
      label: "Providers",
      description: "Provider setup and your default models, reasoning, and model options.",
      icon: ProvidersIcon,
      group: "Agents",
    },
    {
      id: "sessions",
      label: "Sessions",
      description: "New-session defaults, model routing, and delegation.",
      icon: SessionsIcon,
      group: "Agents",
    },
    {
      id: "agent-profile",
      label: "Agent profile",
      description: "Your instructions, skills, and MCP servers, on every host you work on.",
      icon: AgentProfileIcon,
      group: "Agents",
    },
    {
      id: "tools",
      label: "Tools",
      description: "Agent tools and code intelligence.",
      icon: WrenchIcon,
      group: "Agents",
    },
    {
      id: "mcp",
      label: "MCP",
      description: "MCP servers whose tools your agents can use.",
      icon: McpIcon,
      group: "Agents",
    },
    {
      id: "skills",
      label: "Skills",
      description: "Find and manage global skills on each host.",
      icon: SparkleIcon,
      group: "Agents",
      desktopOnly: true,
    },
    {
      id: "devices",
      label: "Devices",
      description: "iOS Simulators and Android Emulators, and agent access to them.",
      icon: SmartphoneIcon,
      group: "Agents",
    },
    {
      id: "source-control",
      label: "Source Control",
      description: "Repository integrations and generated Git writing.",
      icon: GitPullRequestIcon,
      group: "Code",
    },
    {
      id: "codebases",
      label: "Codebases",
      description: "Named sets of folders, on one or more hosts, that one session works in.",
      icon: CodebasesIcon,
      group: "Code",
    },
    {
      id: "review",
      label: "Review companion",
      description: "How review guides are made, and by which agent.",
      icon: BinocularsIcon,
      group: "Code",
    },
    {
      id: "api-access",
      label: "Hosts",
      description: "The computers your agents run on, and how each one is reached.",
      icon: HostsIcon,
      group: "Connections",
    },
    {
      id: "sharing",
      label: "Sharing & access",
      description: "Connect other apps to your hosts, and see the apps and devices that can use them.",
      icon: SharingIcon,
      group: "Connections",
    },
    {
      id: "integrations",
      label: "Integrations",
      description: "Accounts Solus acts on your behalf with.",
      icon: PlugIcon,
      group: "Connections",
    },
    {
      id: "webhooks",
      label: "Webhooks",
      description: "Let other services start agent work on your hosts.",
      icon: WebhookIcon,
      group: "Connections",
    },
    {
      id: "policy",
      label: "Policy",
      description: "What sessions may do and which settings are locked, on this host and for your organization's work.",
      icon: PolicyIcon,
      group: "Connections",
    },
    {
      id: "organization",
      label: "Organization",
      description: "Your organization's name, members, and host rules. Owners change them.",
      icon: OrganizationIcon,
      group: "Organization",
    },
    {
      id: "host",
      label: "Host",
      description: "The selected host's own settings. They apply to all work on it.",
      icon: HostIcon,
      group: "More",
    },
    {
      id: "telemetry",
      label: "Telemetry",
      description: "Usage analytics, and traces, logs, and metrics over OpenTelemetry.",
      icon: BroadcastIcon,
      group: "More",
    },
    {
      id: "experimental",
      label: "Experimental",
      description: "Beta features that may change or go away.",
      icon: FlaskIcon,
      group: "More",
    },
    {
      id: "account",
      label: "Account & sync",
      description: "Who you are signed in as, and what syncs between your devices and hosts.",
      icon: PersonIcon,
      group: "More",
    },
  ];

  // What each page can be found by, beside its label. Pages without a list
  // (Skills, …) are found by their label alone.
  const SEARCH_WORDS: Partial<Record<SettingsTab, readonly string[]>> = {
    account: accountSearch,
    "agent-profile": agentProfileSearch,
    organization: organizationSearch,
    policy: policySearch,
    voice: ["dictation", "dictionary", "custom words", "vocabulary", "aliases", "spelling", "transcription"],
    integrations: ["integration", "github", "google", "drive", "atlassian", "jira", "confluence", "linear", "account", "accounts"],
    mcp: mcpSearch,
    providers: ["claude", "claude code", "codex", "agent", "harness", "seat", "sign in", "login", "cli", "default", "default model", "model options", "model", "reasoning", "context", "fast", "instructions", "project", "projects", "override"],
    telemetry: analyticsSearch,
    host: hostSearch,
    webhooks: webhooksSearch,
    codebases: codebasesSearch,
    sharing: sharingSearch,
  };

  const tabs = $derived(
    ALL_TABS.filter(
      (t) => (!t.desktopOnly || shell.supportsNativeSettings) && settingsTabShown(t.id, accountStore.isSignedIn),
    ),
  );

  // While searching, the nav lists only the pages with a match.
  const searchedTabs = $derived(
    searchQuery ? tabs.filter((t) => tabMatchesSearch(t, searchQuery)) : tabs,
  );

  const groupedTabs = $derived(settingsNavGroups(searchedTabs, accountStore.isSignedIn));

  // Deep links resolve against all destinations, including native-only pages.
  const activeTabMeta = $derived(
    ALL_TABS.find((t) => t.id === session.settingsTab) ?? tabs[0],
  );
  // A page found by its own label shows all of its settings.
  const pageQuery = $derived(
    searchQuery && !wordsMatch(searchQuery, [activeTabMeta.label, activeTabMeta.description]) ? settingsPageQuery(session.settingsTab, searchQuery) : "",
  );
  // Signed out, a host keeps the person's settings, so the pages of personal settings
  // show the settings host too (docs/plans/settings-sync-hosts.md decision 7).
  const personalHostFramedTab = $derived(
    !settings.personal.isSignedIn &&
      (session.settingsTab === "appearance" ||
        session.settingsTab === "chat" ||
        session.settingsTab === "notifications" ||
        session.settingsTab === "review" ||
        session.settingsTab === "telemetry" ||
        session.settingsTab === "experimental"),
  );
  const hostFramedTab = $derived(
    personalHostFramedTab ||
    session.settingsTab === "general" ||
      session.settingsTab === "sessions" ||
      session.settingsTab === "host" ||
      session.settingsTab === "source-control" ||
      session.settingsTab === "providers" ||
      session.settingsTab === "tools" ||
      session.settingsTab === "integrations" ||
      session.settingsTab === "mcp" ||
      session.settingsTab === "skills" ||
      session.settingsTab === "devices" ||
      session.settingsTab === "sharing" ||
      session.settingsTab === "voice",
  );
  // Machines only: the workspace service is a connection this client holds,
  // not a host with settings of its own (docs/plans/cloud-service-model.md §15).
  // The host of the current session leads, then the host on this device
  // (docs/plans/settings-sync-hosts.md decision 7). The rest keep connection order.
  const settingsHosts = $derived.by(() => {
    void serversStore.servers;
    const activeTabId = session.activeTabId;
    const serverIds = serverConnections.serverIds().filter((serverId) => !isSolusApiId(serverId));
    return settingsHostOrder(serverIds, [activeTabId ? runHost(session.runFor(activeTabId)) : undefined, hosts.device?.id]).map((serverId) => ({
      serverId,
      label:
        serversStore.hostFor(serverId)?.label ??
        serverConnections.connectionFor(serverId)?.target.label ??
        serverId,
      address: serversStore.sameNameAddress(serverId),
    }));
  });
  // Sharing & access names its host in its link (`settings/sharing/<host>`).
  const linkedHostId = $derived(session.settingsTab === "sharing" ? session.router.params("settings")?.host : undefined);
  const selectedSettingsHost = $derived.by(() => {
    const serverId = chosenSettingsHostId(settingsHosts.map((host) => host.serverId), [linkedHostId, settingsHost.serverId]);
    return settingsHosts.find((host) => host.serverId === serverId) ?? null;
  });
  // Signed out, while Settings is open, the personal settings on screen are the settings host's.
  $effect(() => {
    const serverId = settings.personal.isSignedIn ? null : (selectedSettingsHost?.serverId ?? null);
    untrack(() => settings.personal.showSettingsHost(serverId));
  });
  onDestroy(() => settings.personal.showSettingsHost(null));

  const selectedSettingsApi = $derived(
    selectedSettingsHost
      ? serverConnections.apiFor(selectedSettingsHost.serverId)
      : null,
  );

  // Settings search finds the MCP page by an installed server's name, so
  // the selected host's list is read while Settings is open.
  $effect(() => {
    const serverId = selectedSettingsHost?.serverId;
    if (!serverId) return;
    return untrack(() => mcpStore.integrations.watch(serverId));
  });

  let searchInputEl = $state<HTMLInputElement | null>(null);

  function goBack() {
    if (session.settingsTab === "api-access" && connectionsNav.isOnPage) {
      connectionsNav.back();
      return;
    }
    onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (searchQuery) {
        e.preventDefault();
        searchQuery = "";
        return;
      }
      e.preventDefault();
      onClose();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "f") {
      e.preventDefault();
      searchInputEl?.focus();
    }
  }

  // Hosts is the one tab with a page under it, so the crumb trail grows a
  // third step. The host page draws its own header.
  const openHostLabel = $derived(
    session.settingsTab !== "api-access" ? null
      : connectionsNav.isAdding ? "Add a machine"
        : connectionsNav.hostId
          ? (serversStore.servers.find(
              (server) => server.id === connectionsNav.hostId,
            )?.label ?? null)
          : null,
  );

  // A codebase page keeps the nav rail: the header names it, and its
  // Codebases crumb goes back to the list.
  const openCodebaseLabel = $derived.by(() => {
    const codebaseId = session.settingsTab === "codebases" ? session.router.params("settings")?.codebase : undefined;
    if (!codebaseId) return null;
    if (codebaseId === NEW_CODEBASE) return "New codebase";
    return codebasesStore.codebaseOf(codebaseId)?.name ?? "Codebase";
  });

  function showCodebaseList() {
    session.router.navigate({ name: "settings", params: { tab: "codebases" } }, { replace: true });
  }

  function selectProjectScope(projectCwd: string | null) {
    session.router.navigate({ name: "settings", params: { tab: session.settingsTab, projectCwd: projectCwd ?? undefined } }, { replace: true });
  }

  function selectHost(serverId: string) {
    if (session.settingsTab === "sharing") session.router.navigate({ name: "settings", params: { tab: "sharing", host: serverId } }, { replace: true });
    else if (selectedSettingsHost?.serverId !== serverId) selectProjectScope(null);
    settingsHost.serverId = serverId;
  }

  function selectTab(tab: SettingsTab) {
    session.selectSettingsTab(tab);
    connectionsNav.back();
  }
</script>

{#snippet backButton()}
  <button
    type="button"
    onclick={goBack}
    aria-label={openHostLabel ? "Back to Hosts" : "Back to workspace"}
    title={openHostLabel ? "Back to Hosts" : "Back to workspace"}
    class={PAGE_SOFT_ICON_BTN}
  >
    <ArrowLeftIcon size={16} strokeWidth={1.5} />
  </button>
{/snippet}

<!--
  Every destination, wrapped. Not a scrolling rail: a horizontal strip hides half
  the tabs off-screen and gives "Custom instructions" no way to be read without a
  swipe. Two rows of chips cost 34px and show all of them at once.

  The way through when the nav column is not there: a pane too narrow to hold
  the column. Hiding navigation without providing its replacement is how a
  responsive rule becomes a dead end.
-->
{#snippet tabChips(padding: string)}
  <div class="shrink-0 flex flex-wrap gap-1.5 {padding}">
    {#each searchedTabs as tab (tab.id)}
      {@const Icon = tab.icon}
      <button
        type="button"
        onclick={() => selectTab(tab.id)}
        aria-current={session.settingsTab === tab.id ? "page" : undefined}
        class="inline-flex h-6.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-workspace-chrome transition-colors [-webkit-tap-highlight-color:transparent] pointer-coarse:tap-area {session.settingsTab ===
 tab.id
 ? 'bg-background font-medium text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)]'
 : 'bg-transparent text-muted-foreground hover:bg-[var(--wash-1)] hover:text-foreground active:bg-[var(--wash-1)]'}"
      >
        <Icon size={15} strokeWidth={1.5} /><span>{tab.label}</span>{#if tab.id === "api-access" && hostUpdatesStore.pendingCount > 0}<span class="text-xs font-normal tabular-nums opacity-60" aria-label="{hostUpdatesStore.pendingCount} updates available">{hostUpdatesStore.pendingCount}</span>{/if}{#if tab.id === "mcp" && mcpStore.integrations.attentionCount > 0}<span class="text-xs font-normal tabular-nums opacity-60" aria-label="{mcpStore.integrations.attentionCount} MCP servers need attention">{mcpStore.integrations.attentionCount}</span>{/if}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet scopeControl()}
  {#if supportsProjectScope(session.settingsTab) && selectedSettingsHost && selectedSettingsApi}
    <div class="flex w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-2 text-base font-medium text-foreground">
      <SettingsProjectScope serverId={selectedSettingsHost.serverId} api={selectedSettingsApi} projectCwd={session.settingsProjectCwd} onSelect={selectProjectScope} onHostSelect={selectHost} />
      <span>on</span>
      <RunOnPicker
        run={{ ...session.defaultRunConfig, location: openFolder(session.defaultRunConfig.location, { serverId: selectedSettingsHost.serverId, path: session.settingsProjectCwd ?? "~" }) }}
        requesterId="settings-scope" variant="scope" settingsHostIds={settingsHosts.map((host) => host.serverId)}
        onSelectSettingsHost={selectHost} onRun={() => {}} onDismiss={() => {}} />
    </div>
  {/if}
{/snippet}



{#snippet hostFrame()}
  {#if selectedSettingsHost}
    <DropdownMenu.Root
      onOpenChange={(next) => {
        if (!next) requestInputFocus();
      }}
    >
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="sm"
            class="h-6.5 shrink-0 gap-1.5 rounded-full bg-background px-2.5 text-workspace-chrome font-normal text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] transition-colors hover:bg-[var(--wash-1)] dark:hover:bg-[var(--wash-1)] aria-expanded:bg-[var(--wash-1)] dark:aria-expanded:bg-[var(--wash-1)]"
            aria-label="Settings host"
          >
            On {selectedSettingsHost.label}
            {#if selectedSettingsHost.address}
              <span class="max-w-40 truncate text-muted-foreground">{selectedSettingsHost.address}</span>
            {/if}
            {#if settingsHosts.length > 1}
              <CaretDownIcon size={15} strokeWidth={1.5} class="opacity-60" />
            {/if}
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[190px]">
        <DropdownMenu.RadioGroup value={selectedSettingsHost.serverId}>
          {#each settingsHosts as host (host.serverId)}
            <DropdownMenu.RadioItem
              value={host.serverId}
              onSelect={() => selectHost(host.serverId)}
            >
              <span class="flex min-w-0 flex-col">
                <span class="truncate">{host.label}</span>
                {#if host.address}
                  <span class="truncate text-xs text-muted-foreground">{host.address}</span>
                {/if}
              </span>
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
{/snippet}

<!-- The dialog owns its keyboard events; menus and child dialogs handle theirs.
     Every settings text field is one field: the border, fill, and focus of the
     review instructions field and of the dropdowns (SettingsSelect), so a field
     never blends into its row. An input with a transparent fill sits inside a
     frame of its own (a search field, the MCP search, an inline name in a list),
     so it gets no second frame. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  role="region"
  aria-label="Settings content"
  data-slot="settings-page"
  tabindex="-1"
  {@attach (element) => element.focus({ preventScroll: true })}
  onkeydown={handleKeydown}
  class="flex h-full w-full min-w-0 overflow-hidden text-workspace-chrome outline-none [--border:color-mix(in_oklch,var(--solus-container-border)_60%,transparent)] [&_button]:text-[length:inherit] [&_input[data-slot=input]:not(.bg-transparent)]:border [&_input[data-slot=input]:not(.bg-transparent)]:border-input [&_input[data-slot=input]:not(.bg-transparent)]:bg-white [&_input[data-slot=input]:not(.bg-transparent)]:shadow-xs/5 dark:[&_input[data-slot=input]:not(.bg-transparent)]:bg-input/30 [&_input[data-slot=input]:not(.bg-transparent):focus-visible]:border-(--solus-accent) [&_input[data-slot=input]:not(.bg-transparent):focus-visible]:ring-0 [&_input[data-slot=input]:not(.bg-transparent):focus-visible]:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)]"
>
  <!-- The dialog is the pane container. Below 48rem, section buttons replace
       the fixed navigation column. A page under Hosts takes the whole dialog:
       its back button and breadcrumb are the way out. -->
  <Sidebar.Provider
    open={true}
    class="w-60 shrink-0 @max-[48rem]/pane:hidden {openHostLabel ? 'hidden' : ''}"
  >
    <Sidebar.Root
      role="navigation"
      aria-label="Settings"
      collapsible="none"
      class="relative border-r border-r-sidebar-border/50 bg-[color:color-mix(in_oklch,var(--card)_99%,var(--foreground))]"
    >
      <Sidebar.Header class="gap-3 px-4 pt-5 pb-3">
        <h2 class="px-[0.625rem] text-lg font-semibold tracking-[-0.01em] text-foreground">Settings</h2>
        <SearchField
          bind:ref={searchInputEl}
          bind:value={() => searchQuery, setSearchQuery}
          placeholder="Search"
          class="w-full basis-auto rounded-lg border-transparent bg-transparent px-3 py-1.5 transition-[background-color] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] focus-within:border-transparent focus-within:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] [&_input]:text-workspace-chrome"
        />
      </Sidebar.Header>
      <Sidebar.Content
        class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 px-[1.1875rem] pb-4"
      >
        {#if searchedTabs.length === 0}
          <p class="px-[0.625rem] py-2 text-workspace-chrome text-muted-foreground">No settings match</p>
        {/if}
        {#each groupedTabs as section (section.group)}
          <Sidebar.Group class="p-0">
            <!-- A group name is the level above the rows, so it starts on the
                 icons' column rather than on the labels'. -->
            <!-- Preferences and More are set apart by space alone, as in T3 Code. -->
            <Sidebar.GroupLabel
              class={section.headingHidden ? "sr-only" : "h-8 pr-2.5 pl-[0.625rem] text-workspace-chrome font-normal text-muted-foreground"}
              >{section.group}</Sidebar.GroupLabel
            >
            <Sidebar.GroupContent>
              <Sidebar.Menu class="gap-px">
                {#each section.items as tab (tab.id)}
                  {@const Icon = tab.icon}
                  {@const active = session.settingsTab === tab.id}
                  <Sidebar.MenuItem>
                    <!-- The same spine the session sidebar's nav rows sit on —
                         settings is the leftmost chrome while it is open, so
                         its column reads as that one. -->
                    <Sidebar.MenuButton
                      type="button"
                      isActive={active}
                      class="group flex h-8 w-full cursor-pointer items-center gap-[0.625rem] rounded-lg px-[0.625rem] text-left text-foreground transition-[color,background] duration-150 hover:bg-sidebar-accent data-[active=true]:bg-sidebar-accent data-[active=true]:font-normal"
                      aria-current={active ? "page" : undefined}
                      onclick={() => selectTab(tab.id)}
                    >
                      <span class="flex shrink-0 items-center"><Icon size={16} /></span>
                      <span
                        class="min-w-0 flex-1 overflow-hidden text-left text-workspace-chrome text-ellipsis whitespace-nowrap"
                        >{tab.label}</span
                      >
                      {#if tab.id === "api-access" && hostUpdatesStore.pendingCount > 0}<span class="shrink-0 text-xs text-muted-foreground opacity-60 tabular-nums" aria-label="{hostUpdatesStore.pendingCount} updates available">{hostUpdatesStore.pendingCount}</span>{/if}
                      {#if tab.id === "mcp" && mcpStore.integrations.attentionCount > 0}<span class="shrink-0 text-xs text-muted-foreground opacity-60 tabular-nums" aria-label="{mcpStore.integrations.attentionCount} MCP servers need attention">{mcpStore.integrations.attentionCount}</span>{/if}
                    </Sidebar.MenuButton>
                  </Sidebar.MenuItem>
                {/each}
              </Sidebar.Menu>
            </Sidebar.GroupContent>
          </Sidebar.Group>
        {/each}
      </Sidebar.Content>
    </Sidebar.Root>
  </Sidebar.Provider>

  <div class="relative flex-1 flex flex-col min-w-0 overflow-hidden">
    <!-- A floating band, like the conversation's: no rule under it. The content
         scrolls beneath and dissolves into the background under the scrim.
         Where the chip strip shows, it sits below the band, so no scrim. -->
    <div
      class="pointer-events-none absolute inset-x-0 top-0 z-[2] h-20 {openHostLabel ? '' : '@max-[48rem]/pane:hidden'}"
      style="background:linear-gradient(to bottom, var(--background) 56%, transparent)"
      aria-hidden="true"
    ></div>
    <header
      class="absolute inset-x-0 top-0 z-[3] flex h-12 items-center justify-between gap-3 px-5"
    >
      <div class="flex min-w-0 items-center gap-2.5">
        {#if openHostLabel}{@render backButton()}{/if}
        {#if openCodebaseLabel}
          <p class="flex min-w-0 items-center gap-1 text-workspace-chrome text-muted-foreground">
            <span class="shrink-0">Settings /</span>
            <button type="button" class="shrink-0 cursor-pointer rounded-sm transition-colors duration-150 hover:text-foreground focus-visible:text-foreground focus-visible:underline focus-visible:outline-none" onclick={showCodebaseList}>{activeTabMeta.label}</button>
            <span class="shrink-0">/</span>
            <span class="truncate text-foreground" aria-current="page">{openCodebaseLabel}</span>
          </p>
        {:else if !openHostLabel}
          <p class="truncate text-workspace-chrome text-muted-foreground">Settings / {activeTabMeta.label}</p>
        {/if}
      {#if openHostLabel}
        <Breadcrumb.Root class="min-w-0">
          <Breadcrumb.List class="gap-2 min-w-0 flex-nowrap text-workspace-chrome">
            <Breadcrumb.Item class="min-w-0">
              <Breadcrumb.Link class="truncate">
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    onclick={() => connectionsNav.back()}
                    >{activeTabMeta.label}</button
                  >
                {/snippet}
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator class="opacity-50">&#8260;</Breadcrumb.Separator>
            <Breadcrumb.Item class="min-w-0">
              <Breadcrumb.Page
                class="font-medium truncate text-foreground "
                >{openHostLabel}</Breadcrumb.Page
              >
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb.Root>
      {/if}
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <SettingsUpdateButton />
        {#if hostFramedTab && !supportsProjectScope(session.settingsTab)}
          {@render hostFrame()}
        {/if}
        <button
          type="button"
          onclick={onClose}
          aria-label="Close settings"
          class={PAGE_SOFT_ICON_BTN}
        >
          <XIcon size={16} strokeWidth={1.5} />
        </button>
      </div>
    </header>

    <!-- The nav column's replacement, not an addition: this appears at exactly
         the pane width where the rail beside it goes. `contents` so it costs
         nothing above that width. -->
    {#if !openHostLabel}
      <div class="contents @min-[48rem]/pane:hidden">
        {@render tabChips('px-[clamp(2rem,3cqi,3rem)] pt-15 pb-2')}
      </div>
    {/if}

    <div
      class="flex-1 overflow-y-auto px-[clamp(2rem,3cqi,3rem)] [&_button]:font-normal"
      role="tabpanel"
      style="-webkit-overflow-scrolling:touch; overscroll-behavior-y:contain"
    >
      <!-- Reading column: the dialog's width. The dialog's default size keeps it
           readable, and the user resizes the dialog to change it. -->
      <div class="w-full pt-20 pb-12 {openHostLabel ? '' : '@max-[48rem]/pane:pt-8'}">
        <!-- A host page heads itself with the host's name and address. -->
        {#if !openHostLabel}
          <header class="mb-10 flex flex-col gap-1.5">
            <h1 class="text-[1.75rem] leading-tight font-medium tracking-[-0.015em] text-foreground">
              {activeTabMeta.label}
            </h1>
            <p class="text-sm text-(--solus-text-secondary)">{activeTabMeta.description}</p>

          </header>
        {/if}
        <div class="flex flex-col gap-10">
          <SettingsSections {pageQuery} {selectedSettingsHost} {selectedSettingsApi} {scopeControl} />
        </div>
      </div>
    </div>
  </div>
</div>
