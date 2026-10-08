<script lang="ts">
  import TaskIcon from "../ui/TaskIcon.svelte";
  import { isSolusApiId } from "@solus/contracts/uplink";
  import { untrack, type Component } from "svelte";
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
    Cloud as CloudIcon,
    NotebookPen as NotePencilIcon,
    Folder as FolderIcon,
    Radio as BroadcastIcon,
    FlaskConical as FlaskIcon,
    ChevronDown as CaretDownIcon,
    GitPullRequest as GitPullRequestIcon,
    Bell as BellIcon,
    Palette as PaletteIcon,
    Smartphone as SmartphoneIcon,
    UserRound as PersonIcon,
    Building2 as OrganizationIcon,
    Server as HostIcon,
    Plug as PlugIcon,
  } from "@lucide/svelte";
  import {
    getWorkspaceContext,
    getClientShellContext,
    getSettingsContext,
    serversStore,
  } from "../../contexts";
  import type { SettingsTab } from "../../contexts/workspace/routing/route-registry";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import * as Breadcrumb from "../ui/breadcrumb";
  import { Button } from "../ui/button";
  import { PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";
  import { SearchField } from "../ui/search-field";
  import SettingsUpdateButton from "./SettingsUpdateButton.svelte";
  import SettingsTabGeneral, { settingItems as generalSearch } from "./SettingsTabGeneral.svelte";
  import SettingsTabAppearance, { settingItems as appearanceSearch } from "./SettingsTabAppearance.svelte";
  import SettingsTabNotifications from "./SettingsTabNotifications.svelte";
  import SettingsTabInstructions, { settingItems as instructionsSearch } from "./SettingsTabInstructions.svelte";
  import SettingsTabTasks, { settingItems as tasksSearch } from "./SettingsTabTasks.svelte";
  import SettingsTabReview, { settingItems as reviewSearch } from "./SettingsTabReview.svelte";
  import ConnectionsPanel from "../connections/ConnectionsPanel.svelte";
  import SettingsTabTools, { settingItems as toolsSearch } from "./SettingsTabTools.svelte";
  import SettingsTabProviders from "./SettingsTabProviders.svelte";
  import SettingsTabSkills from "./SettingsTabSkills.svelte";
  import SettingsTabIntegrations, { searchWords as integrationsSearch } from "./SettingsTabIntegrations.svelte";
  import { integrationsStore } from "./integrations.store.svelte";
  import SettingsTabVoice from "./SettingsTabVoice.svelte";
  import SettingsTabExperimental, { settingItems as experimentalSearch } from "./SettingsTabExperimental.svelte";
  import SettingsTabTelemetry, { settingItems as telemetrySearch } from "./SettingsTabTelemetry.svelte";
  import AnalyticsSettings, { searchWords as analyticsSearch } from "./AnalyticsSettings.svelte";
  import { APP_NOTICE_ROWS, NOTIFICATION_CHANNEL_ROWS, SESSION_EVENT_ROWS } from "./lib/notification-settings";
  import { dataMatches, wordsMatch } from "./lib/settings-search";
  import SettingsTabProjects from "./SettingsTabProjects.svelte";
  import SettingsCloudProjects from "./SettingsCloudProjects.svelte";
  import SettingsTabSourceControl from "./SettingsTabSourceControl.svelte";
  import SettingsTabKeybindings from "./SettingsTabKeybindings.svelte";
  import SettingsTabPersonal, { searchWords as personalSearch } from "./SettingsTabPersonal.svelte";
  import SettingsTabHost, { searchWords as hostSearch } from "./SettingsTabHost.svelte";
  import SettingsTabOrganization, { searchWords as organizationSearch } from "./SettingsTabOrganization.svelte";
  import DeviceSettings from "../devices/DeviceSettings.svelte";
  import { settingsHost } from "./lib/settings-host.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as Sidebar from "../ui/sidebar";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { hosts } from "../../contexts/hosts/hosts.svelte";

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  let searchQuery = $state("");

  function tabMatchesSearch(tab: TabMeta, query: string): boolean {
    return (
      wordsMatch(query, [tab.label, ...(SEARCH_WORDS[tab.id] ?? [])]) ||
      (tab.id === "integrations" && wordsMatch(query, integrationsStore.names())) ||
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
    group: string;
    desktopOnly?: boolean;
    /** Reachable only by deep link (the project panel gear), never in the nav. */
    hiddenFromNav?: boolean;
  }

  // Group order is first-appearance order: Account, Workspace, Capabilities,
  // Input, Advanced. Within a group the list order is the nav order. The
  // Account pages work with no host connected (plans/018 §7).
  const ALL_TABS: TabMeta[] = [
    {
      id: "personal",
      label: "Account & sync",
      description: "Your account, this computer's Solus Cloud link, and settings sync.",
      icon: PersonIcon,
      group: "Account",
    },
    {
      id: "organization",
      label: "Organization",
      description: "Whether your organization syncs all Insights of its work.",
      icon: OrganizationIcon,
      group: "Account",
    },
    {
      id: "general",
      label: "General",
      description: "Agent defaults, sessions, and how projects use your disk.",
      icon: SlidersHorizontalIcon,
      group: "Workspace",
    },
    {
      id: "appearance",
      label: "Appearance",
      description: "Theme, typefaces, and text sizes on this device.",
      icon: PaletteIcon,
      group: "Workspace",
    },
    {
      id: "notifications",
      label: "Notifications",
      description: "Which events notify you, and how.",
      icon: BellIcon,
      group: "Workspace",
    },
    {
      id: "instructions",
      label: "Custom Instructions",
      description: "Text appended to the system prompt on every agent run.",
      icon: NotePencilIcon,
      group: "Workspace",
    },
    {
      id: "tasks",
      label: "Tasks",
      description: "How agents work on tasks, and how a task's lead runs.",
      icon: TaskIcon,
      group: "Workspace",
    },
    {
      id: "projects",
      label: "Projects",
      description: "Your folders and their settings.",
      icon: FolderIcon,
      group: "Workspace",
      hiddenFromNav: true,
    },
    {
      id: "source-control",
      label: "Source Control",
      description: "Repository integrations and generated Git writing.",
      icon: GitPullRequestIcon,
      group: "Workspace",
    },
    {
      id: "review",
      label: "Review companion",
      description: "How review guides are made, and by which agent.",
      icon: BinocularsIcon,
      group: "Capabilities",
    },
    {
      id: "tools",
      label: "Tools",
      description: "Agent tools, apps, and code intelligence.",
      icon: WrenchIcon,
      group: "Capabilities",
    },
    // Host-scoped, so it stays visible on web: the integrations are the host's.
    {
      id: "integrations",
      label: "MCP",
      description: "Remote MCP servers whose tools your agents can use.",
      icon: PlugIcon,
      group: "Capabilities",
    },
    {
      id: "skills",
      label: "Skills",
      description: "Find and manage global skills on each host.",
      icon: SparkleIcon,
      group: "Capabilities",
      desktopOnly: true,
    },
    // Host-scoped, so it stays visible on web and mobile: the devices are on
    // the host, and every client can show them.
    {
      id: "devices",
      label: "Devices",
      description: "iOS Simulators and Android Emulators, and agent access to them.",
      icon: SmartphoneIcon,
      group: "Capabilities",
    },
    {
      id: "providers",
      label: "Providers",
      description: "Accounts Solus acts on your behalf with.",
      icon: CloudIcon,
      group: "Capabilities",
    },
    // Web-visible: a phone or browser manages its hosts through the same
    // Hosts page, driven entirely by RPC against each host.
    {
      id: "api-access",
      label: "Hosts",
      description: "The computers your agents run on, and how each one is reached.",
      icon: HostsIcon,
      group: "Capabilities",
    },
    {
      id: "keybindings",
      label: "Keybindings",
      description: "Rebind any shortcut. Saved on this device only.",
      icon: KeyboardIcon,
      group: "Input",
    },
    {
      id: "voice",
      label: "Voice",
      description: "The on-device speech model used for dictation.",
      icon: MicrophoneIcon,
      group: "Input",
    },
    // Host-scoped, so it stays visible on web and mobile: the exporter runs
    // beside the server, and a phone here configures the host it is on.
    {
      id: "telemetry",
      label: "Telemetry",
      description: "Usage analytics, and traces, logs, and metrics over OpenTelemetry.",
      icon: BroadcastIcon,
      group: "Advanced",
    },
    {
      id: "host",
      label: "Host",
      description: "The selected host's own settings. They apply to all work on it.",
      icon: HostIcon,
      group: "Advanced",
    },
    {
      id: "experimental",
      label: "Experimental",
      description: "Beta features that may change or go away.",
      icon: FlaskIcon,
      group: "Advanced",
    },
  ];

  // What each page can be found by, beside its label. Pages without a list
  // (Projects, Providers, Skills, …) are found by their label alone.
  const keywordsOf = (items: { keywords: readonly string[] }[]) => items.flatMap((item) => item.keywords);
  const SEARCH_WORDS: Partial<Record<SettingsTab, readonly string[]>> = {
    personal: personalSearch,
    organization: organizationSearch,
    general: keywordsOf(generalSearch),
    appearance: keywordsOf(appearanceSearch),
    notifications: [...NOTIFICATION_CHANNEL_ROWS, ...SESSION_EVENT_ROWS, ...APP_NOTICE_ROWS].flatMap((row) => [row.label, ...row.keywords]),
    instructions: keywordsOf(instructionsSearch),
    tasks: keywordsOf(tasksSearch),
    review: keywordsOf(reviewSearch),
    tools: keywordsOf(toolsSearch),
    integrations: integrationsSearch,
    telemetry: [...analyticsSearch, ...keywordsOf(telemetrySearch)],
    host: hostSearch,
    experimental: keywordsOf(experimentalSearch),
  };

  const tabs = $derived(
    ALL_TABS.filter(
      (t) => !t.hiddenFromNav && (!t.desktopOnly || shell.supportsNativeSettings),
    ),
  );

  // While searching, the nav lists only the pages with a match.
  const searchedTabs = $derived(
    searchQuery ? tabs.filter((t) => tabMatchesSearch(t, searchQuery)) : tabs,
  );

  const groupedTabs = $derived.by(() => {
    const order: string[] = [];
    const map = new Map<string, TabMeta[]>();
    for (const t of searchedTabs) {
      if (!map.has(t.group)) {
        map.set(t.group, []);
        order.push(t.group);
      }
      map.get(t.group)!.push(t);
    }
    return order.map((group) => ({ group, items: map.get(group)! }));
  });

  // Resolved against ALL_TABS, not the nav list, so a deep-linked hidden tab
  // (Projects) still titles the page after itself.
  const activeTabMeta = $derived(
    ALL_TABS.find((t) => t.id === session.settingsTab) ?? tabs[0],
  );
  // A page found by its own label shows all of its settings.
  const pageQuery = $derived(
    searchQuery && !wordsMatch(searchQuery, [activeTabMeta.label]) ? searchQuery : "",
  );
  const hostFramedTab = $derived(
    session.settingsTab === "general" ||
      session.settingsTab === "host" ||
      session.settingsTab === "projects" ||
      session.settingsTab === "source-control" ||
      session.settingsTab === "providers" ||
      session.settingsTab === "tools" ||
      session.settingsTab === "integrations" ||
      session.settingsTab === "skills" ||
      session.settingsTab === "devices" ||
      session.settingsTab === "voice",
  );
  // Machines only: the workspace service is a connection this client holds,
  // not a host with settings of its own (docs/plans/cloud-service-model.md §15).
  // The host on this device leads, never the Run on host: Settings are about
  // the machine the user holds. The rest keep connection order.
  const settingsHosts = $derived.by(() => {
    void serversStore.servers;
    const leadHostId = hosts.device?.id;
    const serverIds = serverConnections.connectedServerIds().filter((serverId) => !isSolusApiId(serverId));
    return [
      ...serverIds.filter((serverId) => serverId === leadHostId),
      ...serverIds.filter((serverId) => serverId !== leadHostId),
    ].map((serverId) => ({
      serverId,
      label:
        serversStore.hostFor(serverId)?.label ??
        serverConnections.connectionFor(serverId)?.target.label ??
        serverId,
    }));
  });
  // Until the user picks a host, show the lead host. The first connection is
  // only whichever host answered first.
  const selectedSettingsHost = $derived(
    settingsHosts.find((host) => host.serverId === settingsHost.serverId) ??
      settingsHosts[0] ??
      null,
  );
  const selectedSettingsApi = $derived(
    selectedSettingsHost
      ? serverConnections.apiFor(selectedSettingsHost.serverId)
      : null,
  );

  // Settings search finds the Integrations page by an integration's name, so
  // the selected host's list is read while Settings is open.
  $effect(() => {
    const serverId = selectedSettingsHost?.serverId;
    if (!serverId) return;
    return untrack(() => integrationsStore.watch(serverId));
  });

  let searchInputEl = $state<HTMLInputElement | null>(null);

  function close() {
    session.router.close("settings");
    requestInputFocus();
  }

  function goBack() {
    if (session.settingsTab === "api-access" && connectionsNav.hostId) {
      connectionsNav.back();
      return;
    }
    close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (searchQuery) {
        e.preventDefault();
        searchQuery = "";
        return;
      }
      e.preventDefault();
      close();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "f") {
      e.preventDefault();
      searchInputEl?.focus();
    }
  }

  // Hosts is the one tab with a page under it, so the crumb trail grows a
  // third step rather than the host page having to draw its own header.
  const openHostLabel = $derived(
    session.settingsTab === "api-access" && connectionsNav.hostId
      ? (serversStore.servers.find(
          (server) => server.id === connectionsNav.hostId,
        )?.label ?? null)
      : null,
  );

  function selectTab(tab: SettingsTab) {
    session.selectSettingsTab(tab);
    connectionsNav.back();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

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
        class="inline-flex h-6.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-workspace-chrome transition-colors [-webkit-tap-highlight-color:transparent] pointer-coarse:h-8 {session.settingsTab ===
 tab.id
 ? 'bg-background font-medium text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)]'
 : 'bg-transparent text-muted-foreground hover:bg-[var(--wash-1)] hover:text-foreground active:bg-[var(--wash-1)]'}"
      >
        <Icon size={15} strokeWidth={1.5} /><span>{tab.label}</span>{#if tab.id === "api-access" && hostUpdatesStore.pendingCount > 0}<span class="text-xs font-normal tabular-nums opacity-60" aria-label="{hostUpdatesStore.pendingCount} updates available">{hostUpdatesStore.pendingCount}</span>{/if}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet tabContent()}
  {#if session.settingsTab === "projects"}
    <!-- The organization's projects are the account's, whichever host is
         selected; the host's own folders follow them. -->
    <div class="flex flex-col gap-8">
      <SettingsCloudProjects />
      {#if selectedSettingsHost && selectedSettingsApi}
        <SettingsTabProjects
          serverId={selectedSettingsHost.serverId}
          api={selectedSettingsApi}
        />
      {/if}
    </div>
  {:else if session.settingsTab === "source-control" && selectedSettingsHost && selectedSettingsApi}
    <SettingsTabSourceControl
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
    />
  {:else if session.settingsTab === "general" && selectedSettingsHost && selectedSettingsApi}
    <SettingsTabGeneral
      searchQuery={pageQuery}
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
      hostLabel={selectedSettingsHost.label}
    />
  {:else if session.settingsTab === "tasks"}
    <SettingsTabTasks searchQuery={pageQuery} />
  {:else if session.settingsTab === "personal"}
    <SettingsTabPersonal searchQuery={pageQuery} />
  {:else if session.settingsTab === "organization"}
    <SettingsTabOrganization searchQuery={pageQuery} />
  {:else if session.settingsTab === "host" && selectedSettingsHost}
    <SettingsTabHost searchQuery={pageQuery} serverId={selectedSettingsHost.serverId} />
  {:else if session.settingsTab === "appearance"}
    <SettingsTabAppearance searchQuery={pageQuery} />
  {:else if session.settingsTab === "notifications"}
    <SettingsTabNotifications searchQuery={pageQuery} />
  {:else if session.settingsTab === "instructions"}
    <SettingsTabInstructions searchQuery={pageQuery} />
  {:else if session.settingsTab === "review"}
    <SettingsTabReview searchQuery={pageQuery} />
  {:else if session.settingsTab === "voice" && selectedSettingsHost && selectedSettingsApi}
    <SettingsTabVoice
      serverId={selectedSettingsHost.serverId}
      hostLabel={selectedSettingsHost.label}
    />
  {:else if session.settingsTab === "telemetry"}
    <AnalyticsSettings searchQuery={pageQuery} host={selectedSettingsHost} />
    {#if selectedSettingsHost && selectedSettingsApi}
      <SettingsTabTelemetry
        searchQuery={pageQuery}
        serverId={selectedSettingsHost.serverId}
        api={selectedSettingsApi}
      />
    {/if}
  {:else if session.settingsTab === "experimental"}
    <SettingsTabExperimental searchQuery={pageQuery} />
  {:else if session.settingsTab === "providers" && selectedSettingsHost}
    <SettingsTabProviders serverId={selectedSettingsHost.serverId} />
  {:else if session.settingsTab === "api-access"}
    <ConnectionsPanel />
  {:else if session.settingsTab === "tools" && selectedSettingsHost && selectedSettingsApi}
    <SettingsTabTools
      searchQuery={pageQuery}
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
      hostLabel={selectedSettingsHost.label}
    />
  {:else if session.settingsTab === "integrations" && selectedSettingsHost}
    {#key selectedSettingsHost.serverId}
      <SettingsTabIntegrations
        searchQuery={pageQuery}
        serverId={selectedSettingsHost.serverId}
        hostLabel={selectedSettingsHost.label}
      />
    {/key}
  {:else if session.settingsTab === "skills" && selectedSettingsHost && selectedSettingsApi}
    <SettingsTabSkills
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
      hostLabel={selectedSettingsHost.label}
    />
  {:else if session.settingsTab === "devices" && selectedSettingsHost}
    {#key selectedSettingsHost.serverId}
      <DeviceSettings serverId={selectedSettingsHost.serverId} />
    {/key}
  {:else if session.settingsTab === "keybindings"}
    <SettingsTabKeybindings bind:searchQuery={() => pageQuery, setSearchQuery} />
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
              onSelect={() => (settingsHost.serverId = host.serverId)}
            >
              <span class="truncate">{host.label}</span>
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
{/snippet}

<!-- The nav column's lead: the window-control band, plus the 7px the session
     sidebar gets for free from its floating card (4px shell gutter + 1px
     border + its own 2px top pad) and this flush column does not. That lands
     the first control on the exact y the sidebar's first row occupies. -->
<div
  class="flex h-full overflow-hidden text-workspace-chrome [--input:color-mix(in_oklch,var(--solus-input-border)_60%,transparent)] [--border:color-mix(in_oklch,var(--solus-container-border)_60%,transparent)] [&_button]:text-[length:inherit] [--settings-nav-lead:calc(var(--solus-page-top-inset,0px)+0.4375rem)]"
>
  <!-- Width and surface are the session sidebar's, not a second measure: the
       settings column replaces it in place, so the shell must not shift.

       `cqi`, not `vw`: settings is in `FLUSH_PAGES`, so it opens as a
       companion pane as well as a full page. Measured against the window, a
       24vw rail on a 1440px display is 346px wide — inside a 400px companion
       that leaves about 40px for the content it is meant to navigate. The
       nearest container is `pane`; there is none between here and there.

       Below 48rem of pane the rail goes entirely rather than getting thinner.
       A navigation column narrower than its own labels is not a degraded
       rail, it is a second problem: the tab picker in the header is the way
       through at that width. -->
  <Sidebar.Provider
    open={true}
    class="w-[clamp(18.75rem,24cqi,22.5rem)] shrink-0 @max-[48rem]/pane:hidden"
  >
    <Sidebar.Root
      role="navigation"
      aria-label="Settings"
      collapsible="none"
      class="relative border-r border-r-sidebar-border/50 bg-[color:color-mix(in_oklch,var(--card)_99%,var(--foreground))]"
    >
      <div
        class="workspace-titlebar absolute inset-x-0 top-0 h-(--solus-titlebar-height)"
        aria-hidden="true"
      ></div>
      <!-- Two measurements are borrowed, not invented: the lead band above the
           first control, and the 1.1875rem row inset. Together they land the
           search field on the exact x/y the session sidebar's first row
           occupies, so switching between the two doesn't move the column.
           (The page owns its titlebar chrome, so the window-control clearance
           lives in that lead rather than as an outlet pad above the whole
           surface — that is what lets this column reach the window's top.) -->
      <Sidebar.Header class="gap-3 p-0 px-[1.1875rem] pt-(--settings-nav-lead) pb-3">
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
        {#if groupedTabs.length === 0}
          <p class="px-[0.625rem] py-2 text-workspace-chrome text-muted-foreground">No settings match</p>
        {/if}
        {#each groupedTabs as section (section.group)}
          <Sidebar.Group class="p-0">
            <!-- A group name is the level above the rows, so it starts on the
                 icons' column rather than on the labels'. -->
            <Sidebar.GroupLabel
              class="h-8 pr-2.5 pl-[0.625rem] text-workspace-chrome font-normal text-muted-foreground"
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

  <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
    <!-- The window's chrome row holds the crumb trail and the page's actions.
         The page title heads the reading column below, over its sections. -->
    <header
      class="workspace-titlebar h-(--solus-chrome-row-h) flex items-center justify-between gap-3 px-[clamp(2rem,3cqi,3rem)] shrink-0"
    >
      <div class="flex min-w-0 items-center gap-2.5">
        {@render backButton()}
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
        {#if hostFramedTab}
          {@render hostFrame()}
        {/if}
        <button
          type="button"
          onclick={close}
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
    <div class="contents @min-[48rem]/pane:hidden">
      {@render tabChips('px-[clamp(2rem,3cqi,3rem)] pt-3 pb-2')}
    </div>

    <div
      class="flex-1 overflow-y-auto px-[clamp(2rem,3cqi,3rem)] [&_button]:font-normal"
      role="tabpanel"
      style="-webkit-overflow-scrolling:touch; overscroll-behavior-y:contain"
    >
      <!-- Reading column: a fixed 48rem measure, the width a settings row
           stays legible at. A control sits at the trailing edge of its row,
           so a column that grew with the pane put a 1200px gap between a
           description and the switch it describes on a wide display. A wide
           pane shows margin instead. `w-full` keeps it from overflowing
           panes narrower than that. -->
      <div class="mx-auto w-full max-w-3xl pt-8 pb-12">
        <header class="mb-10 flex flex-col gap-1.5">
          <h1 class="text-[1.75rem] leading-tight font-medium tracking-[-0.015em] text-foreground">
            {openHostLabel ?? activeTabMeta.label}
          </h1>
          {#if !openHostLabel}
            <p class="text-sm text-(--solus-text-secondary)">{activeTabMeta.description}</p>
          {/if}
        </header>
        <div class="flex flex-col gap-10">
          {@render tabContent()}
        </div>
      </div>
    </div>
  </div>
</div>
