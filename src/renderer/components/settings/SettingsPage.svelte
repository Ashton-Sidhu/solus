<script lang="ts">
  import type { Component } from "svelte";
  import {
    XIcon,
    SlidersHorizontalIcon,
    WrenchIcon,
    SparkleIcon,
    PlugsConnectedIcon,
    KeyboardIcon,
    MicrophoneIcon,
    BinocularsIcon,
    GithubLogoIcon,
    NotePencilIcon,
    FolderIcon,
  } from "phosphor-svelte";
  import { getWorkspaceContext, getWindowContext, runtime } from "../../contexts";
  import { Button } from "../ui/button";
  import { SearchField } from "../ui/search-field";
  import SettingsTabGeneral from "./SettingsTabGeneral.svelte";
  import SettingsTabInstructions from "./SettingsTabInstructions.svelte";
  import SettingsTabReview from "./SettingsTabReview.svelte";
  import ConnectionsPanel from "../connections/ConnectionsPanel.svelte";
  import GitHubConnect from "../connections/GitHubConnect.svelte";
  import SettingsTabTools from "./SettingsTabTools.svelte";
  import SettingsTabSkills from "./SettingsTabSkills.svelte";
  import SettingsTabVoice from "./SettingsTabVoice.svelte";
  import SettingsTabProjects from "./SettingsTabProjects.svelte";
  import SettingsTabKeybindings from "./SettingsTabKeybindings.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as Sidebar from "../ui/sidebar";

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();

  type SettingsTab =
    | "general"
    | "instructions"
    | "review"
    | "github"
    | "api-access"
    | "tools"
    | "skills"
    | "voice"
    | "projects"
    | "keybindings";

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
      id: "github",
      label: "Providers",
      description: "Accounts Solus acts on your behalf with.",
      icon: GithubLogoIcon,
      group: "Capabilities",
      desktopOnly: true,
    },
    {
      id: "api-access",
      label: "Connections",
      description: "Reach this Solus server from your other devices.",
      icon: PlugsConnectedIcon,
      group: "Capabilities",
      desktopOnly: true,
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
      description: "Dictation behaviour and the on-device speech model.",
      icon: MicrophoneIcon,
      group: "Input",
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

  let searchQuery = $state("");
  let searchInputEl = $state<HTMLInputElement | null>(null);

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

  function selectTab(tab: SettingsTab) {
    session.settingsTab = tab;
    searchQuery = "";
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet tabContent()}
  {#if session.settingsTab === "projects"}
    <SettingsTabProjects />
  {:else if session.settingsTab === "general"}
    <SettingsTabGeneral {searchQuery} />
  {:else if session.settingsTab === "instructions"}
    <SettingsTabInstructions {searchQuery} />
  {:else if session.settingsTab === "review"}
    <SettingsTabReview {searchQuery} />
  {:else if session.settingsTab === "voice"}
    <SettingsTabVoice />
  {:else if session.settingsTab === "github"}
    <GitHubConnect />
  {:else if session.settingsTab === "api-access"}
    <ConnectionsPanel />
  {:else if session.settingsTab === "tools"}
    <SettingsTabTools {searchQuery} />
  {:else if session.settingsTab === "skills"}
    <SettingsTabSkills />
  {:else if session.settingsTab === "keybindings"}
    <SettingsTabKeybindings {searchQuery} />
  {/if}
{/snippet}

{#if runtime.isMobileViewport}
  <div class="flex flex-col h-full overflow-hidden">
    <header
      class="shrink-0 flex items-center justify-between px-4 pb-2.5 pt-[max(0.75rem,env(safe-area-inset-top,0px))] border-b border-(--solus-container-border)"
    >
      <span
        class="text-[1.125rem] font-semibold tracking-[-0.01em] text-(--solus-text-primary)"
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
          class="shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[0.8125rem] font-medium [-webkit-tap-highlight-color:transparent] {session.settingsTab ===
          tab.id
            ? 'bg-(--solus-accent-light) text-(--solus-accent)'
            : 'bg-(--solus-surface-hover) text-(--solus-text-secondary) active:bg-(--solus-surface-tertiary)'}"
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
  <div class="flex h-full overflow-hidden [--settings-header-height:2.875rem]">
    <Sidebar.Provider open={true} class="w-[clamp(14.75rem,13vw,17rem)] shrink-0">
      <Sidebar.Root
        role="navigation"
        aria-label="Settings"
        collapsible="none"
        class="bg-sidebar border-r border-r-sidebar-border"
      >
        <!-- Settings forces the session sidebar closed, so this nav is the leftmost
           chrome and sits under the macOS traffic lights. The strip clears them and
           lines the search field up with the bottom of the content header. -->
        <Sidebar.Header class="gap-0 p-0 px-3 pb-3">
          <div class="h-(--settings-header-height) shrink-0"></div>
          <SearchField
            bind:ref={searchInputEl}
            bind:value={searchQuery}
            placeholder="Search settings"
            class="basis-auto rounded-md border-border bg-card px-2 py-1.5 shadow-xs [&_input]:text-[0.75rem]"
          />
        </Sidebar.Header>
        <Sidebar.Content
          class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-px px-3 pb-4"
        >
          {#each groupedTabs as section (section.group)}
            <Sidebar.Group class="p-0 first:[&_[data-sidebar=group-label]]:pt-3">
              <Sidebar.GroupLabel
                class="h-auto text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground px-2 pt-4 pb-1.5"
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
                        class="relative gap-2 h-8 px-2 rounded-md border cursor-pointer text-left outline-none [transition:color_0.15s_ease,background_0.15s_ease,border-color_0.15s_ease]
                        {active
                          ? 'border-border shadow-xs data-[active=true]:bg-card data-[active=true]:font-normal data-[active=true]:text-foreground'
                          : 'border-transparent bg-transparent text-muted-foreground [@media(hover:hover)]:hover:text-foreground [@media(hover:hover)]:hover:bg-muted'}"
                        aria-current={active ? "page" : undefined}
                        onclick={() => selectTab(tab.id)}
                      >
                        <span
                          class="flex items-center shrink-0 [transition:color_0.15s_ease]
                        {active ? 'text-foreground' : 'text-muted-foreground'}"
                          ><Icon size={15} /></span
                        >
                        <span
                          class="text-[0.8125rem] tracking-[-0.01em] flex-1 min-w-0 text-left whitespace-nowrap overflow-hidden text-ellipsis
                        {active ? 'font-medium' : 'font-normal'}"
                          >{tab.label}</span
                        >
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
            class="shrink-0 flex-row items-center gap-1.5 px-4 py-3 border-t border-t-sidebar-border text-[0.625rem] text-muted-foreground"
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
      <header
        class="h-(--settings-header-height) border-b border-b-border flex items-center justify-between gap-3 px-[clamp(2rem,3vw,3rem)] shrink-0"
      >
        <nav
          class="flex items-center gap-2 min-w-0 text-[0.75rem] text-muted-foreground"
          aria-label="Breadcrumb"
        >
          <span>Settings</span>
          <span class="opacity-50">&#8260;</span>
          <span class="font-medium text-foreground truncate" aria-current="page"
            >{activeTabMeta.label}</span
          >
        </nav>
        <Button
          variant="ghost"
          size="icon-sm"
          onclick={close}
          aria-label="Close settings"
          class="shrink-0 text-muted-foreground"
        >
          <XIcon size={14} />
        </Button>
      </header>

      <div
        class="flex-1 overflow-y-auto px-[clamp(2rem,3vw,3rem)]"
        role="tabpanel"
        style="-webkit-overflow-scrolling:touch; overscroll-behavior-y:contain"
      >
        <!-- Fluid reading column: grows with the window between 45rem and 72rem.
             `w-full` keeps it from overflowing narrow panes — max-width only caps. -->
        <div class="mx-auto w-full max-w-[clamp(45rem,66vw,72rem)] pt-8 pb-16">
          <h1
            class="text-[clamp(1.25rem,1.15rem+0.35vw,1.5rem)] font-semibold tracking-tight text-foreground"
          >
            {activeTabMeta.label}
          </h1>
          <p class="mt-1 text-[0.8125rem] text-muted-foreground">
            {activeTabMeta.description}
          </p>
          <div class="mt-8 flex flex-col gap-7">
            {@render tabContent()}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}
