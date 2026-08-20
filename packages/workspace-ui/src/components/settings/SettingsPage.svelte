<script lang="ts">
  import type { Component } from "svelte";
  import {
    X as XIcon,
    SlidersHorizontal as SlidersHorizontalIcon,
    Wrench as WrenchIcon,
    Sparkles as SparkleIcon,
    Cable as PlugsConnectedIcon,
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
  } from "@lucide/svelte";
  import {
    getWorkspaceContext,
    getWindowContext,
    runtime,
    serversStore,
  } from "../../contexts";
  import type { SettingsTab } from "../../contexts/workspace/routing/route-registry";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import * as Breadcrumb from "../ui/breadcrumb";
  import { Button } from "../ui/button";
  import { SearchField } from "../ui/search-field";
  import SettingsTabGeneral from "./SettingsTabGeneral.svelte";
  import SettingsTabInstructions from "./SettingsTabInstructions.svelte";
  import SettingsTabReview from "./SettingsTabReview.svelte";
  import ConnectionsPanel from "../connections/ConnectionsPanel.svelte";
  import SettingsTabTools from "./SettingsTabTools.svelte";
  import SettingsTabProviders from "./SettingsTabProviders.svelte";
  import SettingsTabSkills from "./SettingsTabSkills.svelte";
  import SettingsTabVoice from "./SettingsTabVoice.svelte";
  import SettingsTabExperimental from "./SettingsTabExperimental.svelte";
  import SettingsTabTelemetry from "./SettingsTabTelemetry.svelte";
  import SettingsTabProjects from "./SettingsTabProjects.svelte";
  import SettingsTabSourceControl from "./SettingsTabSourceControl.svelte";
  import SettingsTabKeybindings from "./SettingsTabKeybindings.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as Sidebar from "../ui/sidebar";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { serverConnections } from "@solus/client-core/server-connections";

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();

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

  const ALL_TABS: TabMeta[] = [
    {
      id: "general",
      label: "General",
      description: "Appearance, agent defaults, and how sessions use your disk.",
      icon: SlidersHorizontalIcon,
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
      id: "projects",
      label: "Projects",
      description: "Folders you've opened in Solus, and their settings.",
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
      description: "How review guides are generated, and which agent writes them.",
      icon: BinocularsIcon,
      group: "Capabilities",
    },
    {
      id: "tools",
      label: "Tools",
      description: "The external apps Solus hands files and directories off to.",
      icon: WrenchIcon,
      group: "Capabilities",
      desktopOnly: true,
    },
    {
      id: "skills",
      label: "Skills",
      description: "Browse the skills.sh registry and install into your agents.",
      icon: SparkleIcon,
      group: "Capabilities",
      desktopOnly: true,
    },
    {
      id: "providers",
      label: "Providers",
      description: "Accounts Solus acts on your behalf with.",
      icon: CloudIcon,
      group: "Capabilities",
    },
    // Web-visible: a phone or browser manages its hosts through the same
    // Connections page, driven entirely by RPC against the connected server.
    {
      id: "api-access",
      label: "Connections",
      description: "Reach this Solus server from your other devices.",
      icon: PlugsConnectedIcon,
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
      description: "Send this host's traces, logs, and metrics to an OpenTelemetry collector.",
      icon: BroadcastIcon,
      group: "Advanced",
    },
    {
      id: "experimental",
      label: "Experimental",
      description: "Opt in to beta features that may change or be removed.",
      icon: FlaskIcon,
      group: "Advanced",
    },
  ];

  const tabs = $derived(
    ALL_TABS.filter(
      (t) => !t.hiddenFromNav && (!t.desktopOnly || !windowCtx.isWeb),
    ),
  );

  const groupedTabs = $derived.by(() => {
    const order: string[] = [];
    const map = new Map<string, TabMeta[]>();
    for (const t of tabs) {
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
  const hostFramedTab = $derived(
    session.settingsTab === "general" ||
      session.settingsTab === "projects" ||
      session.settingsTab === "source-control" ||
      session.settingsTab === "providers" ||
      session.settingsTab === "tools" ||
      session.settingsTab === "skills" ||
      session.settingsTab === "voice",
  );
  let selectedSettingsServerId = $state(
    serverConnections.defaultServerId() ?? "",
  );
  const settingsHosts = $derived.by(() => {
    void serversStore.servers;
    return serverConnections.connectedServerIds().map((serverId) => ({
      serverId,
      label:
        serversStore.hostFor(serverId)?.label ??
        serverConnections.connectionFor(serverId)?.target.label ??
        serverId,
    }));
  });
  const selectedSettingsHost = $derived(
    settingsHosts.find((host) => host.serverId === selectedSettingsServerId) ??
      settingsHosts[0] ??
      null,
  );
  const selectedSettingsApi = $derived(
    selectedSettingsHost
      ? serverConnections.apiFor(selectedSettingsHost.serverId)
      : null,
  );

  $effect(() => {
    if (selectedSettingsHost) return;
    selectedSettingsServerId =
      serverConnections.defaultServerId() ?? settingsHosts[0]?.serverId ?? "";
  });

  let searchQuery = $state("");
  let searchInputEl = $state<HTMLInputElement | null>(null);

  // The same spine the session sidebar's nav rows sit on — settings is the
  // leftmost chrome while it is open, so its column reads as that one.
  const navRow =
    "group flex h-8 w-full cursor-pointer items-center gap-[0.625rem] rounded bg-transparent px-[0.625rem] text-left text-muted-foreground transition-[color,background] duration-150 hover:bg-accent hover:text-foreground [.is-laptop-display_&]:h-7 [.is-laptop-display_&]:gap-2 [.is-laptop-display_&]:px-2";
  const navRowActive = "text-foreground";
  const navIcon = "flex shrink-0 items-center";
  const navLabel =
    "flex-1 min-w-0 overflow-hidden text-left text-workspace-chrome text-ellipsis whitespace-nowrap";

  function close() {
    session.closeSettings();
    requestInputFocus();
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

  // Connections is the one tab with a page under it, so the crumb trail grows a
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
    searchQuery = "";
    connectionsNav.back();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet tabContent()}
  {#if runtime.isMobileViewport && hostFramedTab}
    {@render hostFrame()}
  {/if}
  {#if session.settingsTab === "projects" && selectedSettingsHost && selectedSettingsApi}
    <SettingsTabProjects
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
    />
  {:else if session.settingsTab === "source-control" && selectedSettingsHost && selectedSettingsApi}
    <SettingsTabSourceControl
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
    />
  {:else if session.settingsTab === "general" && selectedSettingsHost && selectedSettingsApi}
    <SettingsTabGeneral
      {searchQuery}
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
      hostLabel={selectedSettingsHost.label}
    />
  {:else if session.settingsTab === "instructions"}
    <SettingsTabInstructions {searchQuery} />
  {:else if session.settingsTab === "review"}
    <SettingsTabReview {searchQuery} />
  {:else if session.settingsTab === "voice" && selectedSettingsHost && selectedSettingsApi}
    <SettingsTabVoice
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
      hostLabel={selectedSettingsHost.label}
    />
  {:else if session.settingsTab === "telemetry" && selectedSettingsHost && selectedSettingsApi}
    <SettingsTabTelemetry
      {searchQuery}
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
    />
  {:else if session.settingsTab === "experimental"}
    <SettingsTabExperimental {searchQuery} />
  {:else if session.settingsTab === "providers" && selectedSettingsHost}
    <SettingsTabProviders serverId={selectedSettingsHost.serverId} />
  {:else if session.settingsTab === "api-access"}
    <ConnectionsPanel />
  {:else if session.settingsTab === "tools" && selectedSettingsHost && selectedSettingsApi}
    <SettingsTabTools
      {searchQuery}
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
      hostLabel={selectedSettingsHost.label}
    />
  {:else if session.settingsTab === "skills" && selectedSettingsHost && selectedSettingsApi}
    <SettingsTabSkills
      serverId={selectedSettingsHost.serverId}
      api={selectedSettingsApi}
      hostLabel={selectedSettingsHost.label}
    />
  {:else if session.settingsTab === "keybindings"}
    <SettingsTabKeybindings {searchQuery} />
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
            variant="outline"
            size="sm"
            class="h-7 shrink-0 gap-1.5 text-xs font-normal text-muted-foreground shadow-xs"
            aria-label="Settings host"
          >
            On {selectedSettingsHost.label}
            {#if settingsHosts.length > 1}
              <CaretDownIcon size={10} class="opacity-60" />
            {/if}
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[190px]">
        <DropdownMenu.RadioGroup value={selectedSettingsHost.serverId}>
          {#each settingsHosts as host (host.serverId)}
            <DropdownMenu.RadioItem
              value={host.serverId}
              onSelect={() => (selectedSettingsServerId = host.serverId)}
            >
              <span class="truncate">{host.label}</span>
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
{/snippet}

{#if runtime.isMobileViewport}
  <div class="flex flex-col h-full overflow-hidden text-workspace-chrome">
    <header
      class="shrink-0 flex items-center justify-between px-4 pb-2.5 pt-[max(0.75rem,env(safe-area-inset-top,0px))] border-b border-(--solus-container-border)"
    >
      <span
        class="text-sm font-medium text-(--solus-text-primary)"
        >Settings</span
      >
      <Button
        variant="ghost"
        size="icon"
        onclick={close}
        aria-label="Close settings"
        class="-mr-1.5 rounded-full text-(--solus-text-tertiary) active:bg-(--solus-surface-hover) [-webkit-tap-highlight-color:transparent]"
      >
        <XIcon size={18} />
      </Button>
    </header>

    <div
      class="shrink-0 flex gap-1.5 overflow-x-auto px-3 py-2.5 [scrollbar-width:none] [-webkit-overflow-scrolling:touch]"
    >
      {#each tabs as tab (tab.id)}
        {@const Icon = tab.icon}
        <button
          type="button"
          onclick={() => selectTab(tab.id)}
          aria-current={session.settingsTab === tab.id ? "page" : undefined}
          class="shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium [-webkit-tap-highlight-color:transparent] {session.settingsTab ===
 tab.id
 ? 'bg-(--solus-accent-light) text-(--solus-accent)'
 : 'bg-(--solus-surface-hover) font-secondary text-(--solus-text-secondary) active:bg-(--solus-surface-tertiary)'}"
        >
          <Icon size={15} /><span>{tab.label}</span>
        </button>
      {/each}
    </div>

    <div
      class="flex-1 overflow-y-auto px-4 pt-1 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] [overscroll-behavior-y:contain] [-webkit-overflow-scrolling:touch]"
      role="tabpanel"
    >
      <div class="flex flex-col gap-5">
        {@render tabContent()}
      </div>
    </div>
  </div>
{:else}
  <!-- The nav column's lead: the window-control band, plus the 7px the session
       sidebar gets for free from its floating card (4px shell gutter + 1px
       border + its own 2px top pad) and this flush column does not. That lands
       the first control on the exact y the sidebar's first row occupies. -->
  <div
    class="flex h-full overflow-hidden text-workspace-chrome [--settings-nav-lead:calc(var(--solus-page-top-inset,0px)+0.4375rem)]"
  >
    <!-- Width and surface are the session sidebar's, not a second measure: the
         settings column replaces it in place, so the shell must not shift. -->
    <Sidebar.Provider
      open={true}
      class="w-[clamp(18.75rem,24vw,22.5rem)] shrink-0 [.is-laptop-display_&]:w-[clamp(16rem,22vw,19rem)]"
    >
      <Sidebar.Root
        role="navigation"
        aria-label="Settings"
        collapsible="none"
        class="relative border-r border-r-sidebar-border bg-[color-mix(in_oklch,var(--card)_99%,var(--foreground))]"
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
        <Sidebar.Header class="gap-0 p-0 px-[1.1875rem] pt-(--settings-nav-lead) pb-3 [.is-laptop-display_&]:px-4 [.is-laptop-display_&]:pb-2.5">
          <SearchField
            bind:ref={searchInputEl}
            bind:value={searchQuery}
            placeholder="Search settings"
            class="w-full basis-auto rounded border-border bg-card px-2 py-1.5 shadow-xs [&_input]:text-workspace-chrome [.is-laptop-display_&]:py-1"
          />
        </Sidebar.Header>
        <Sidebar.Content
          class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2 px-[1.1875rem] pb-4 [.is-laptop-display_&]:gap-1.5 [.is-laptop-display_&]:px-4 [.is-laptop-display_&]:pb-3"
        >
          {#each groupedTabs as section (section.group)}
            <Sidebar.Group class="p-0">
              <!-- A group name is the level above the rows, so it starts on the
                   icons' column rather than on the labels'. -->
              <Sidebar.GroupLabel
                class="h-[2.125rem] pr-2.5 pl-[0.625rem] text-[0.875em] font-medium uppercase text-muted-foreground [.is-laptop-display_&]:h-7 [.is-laptop-display_&]:pl-2"
                >{section.group}</Sidebar.GroupLabel
              >
              <Sidebar.GroupContent>
                <Sidebar.Menu class="gap-px">
                  {#each section.items as tab (tab.id)}
                    {@const Icon = tab.icon}
                    {@const active = session.settingsTab === tab.id}
                    <Sidebar.MenuItem>
                      <Sidebar.MenuButton
                        type="button"
                        isActive={active}
                        class="{navRow} {active ? navRowActive : ''}"
                        aria-current={active ? "page" : undefined}
                        onclick={() => selectTab(tab.id)}
                      >
                        <span class={navIcon}><Icon size={16} /></span>
                        <span class={navLabel}>{tab.label}</span>
                      </Sidebar.MenuButton>
                    </Sidebar.MenuItem>
                  {/each}
                </Sidebar.Menu>
              </Sidebar.GroupContent>
            </Sidebar.Group>
          {/each}
        </Sidebar.Content>
        {#if session.staticInfo?.version}
          <Sidebar.Footer
            class="shrink-0 flex-row items-center gap-1.5 border-t border-t-sidebar-border px-[1.1875rem] pt-2 pb-2.5 text-[0.875em] text-muted-foreground [.is-laptop-display_&]:px-4 [.is-laptop-display_&]:py-2"
          >
            <span>v{session.staticInfo.version}</span>
            {#if session.staticInfo.email}
              <span class="opacity-40">&middot;</span>
              <span class="truncate">{session.staticInfo.email}</span>
            {/if}
          </Sidebar.Footer>
        {/if}
      </Sidebar.Root>
    </Sidebar.Provider>

    <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
      <!-- The page title lives in the window's own chrome row — the same band
           every other full-page surface titles itself in — not in a second strip
           below it, and not above the sections, where a duplicate of it pushed
           the first setting a screenful down. -->
      <header
        class="workspace-titlebar h-(--solus-chrome-row-h) border-b border-b-border flex items-center justify-between gap-3 px-[clamp(2rem,3vw,3rem)] shrink-0 [.is-laptop-display_&]:px-7"
      >
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
        {:else}
          <div class="flex min-w-0 items-baseline gap-2.5">
            <h1
              class="shrink-0 text-workspace-chrome font-medium text-foreground"
            >
              {activeTabMeta.label}
            </h1>
            <span
              class="h-2.5 w-px shrink-0 self-center bg-border"
              aria-hidden="true"
            ></span>
            <p class="min-w-0 truncate text-[0.875em] text-muted-foreground">
              {activeTabMeta.description}
            </p>
          </div>
        {/if}
        <div class="flex shrink-0 items-center gap-2">
          {#if hostFramedTab}
            {@render hostFrame()}
          {/if}
          <Button
            variant="ghost"
            size="icon-sm"
            onclick={close}
            aria-label="Close settings"
            class="shrink-0 text-muted-foreground"
          >
            <XIcon size={14} />
          </Button>
        </div>
      </header>

      <div
        class="flex-1 overflow-y-auto px-[clamp(2rem,3vw,3rem)] [.is-laptop-display_&]:px-7"
        role="tabpanel"
        style="-webkit-overflow-scrolling:touch; overscroll-behavior-y:contain"
      >
        <!-- Fluid reading column: grows with the window between 45rem and 72rem.
             `w-full` keeps it from overflowing narrow panes — max-width only caps. -->
        <div class="mx-auto w-full max-w-[clamp(45rem,66vw,72rem)] pt-8 pb-16 [.is-laptop-display_&]:max-w-[60rem] [.is-laptop-display_&]:pt-6 [.is-laptop-display_&]:pb-12">
          <div class="flex flex-col gap-7 [.is-laptop-display_&]:gap-5">
            {@render tabContent()}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}
