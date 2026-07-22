<script lang="ts">
  import type { Component } from "svelte";
  import {
    MagnifyingGlassIcon,
    XIcon,
    GearSixIcon,
    SlidersHorizontalIcon,
    WrenchIcon,
    SparkleIcon,
    PlugsConnectedIcon,
    KeyboardIcon,
    MicrophoneIcon,
    BinocularsIcon,
    GithubLogoIcon,
  } from "phosphor-svelte";
  import { getWorkspaceContext, getWindowContext, runtime } from "../../contexts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsTabGeneral from "./SettingsTabGeneral.svelte";
  import SettingsTabReview from "./SettingsTabReview.svelte";
  import SettingsTabConnections from "./SettingsTabConnections.svelte";
  import SettingsTabGitHub from "./SettingsTabGitHub.svelte";
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
    icon: Component<{ size?: number; class?: string }>;
    group: string;
    desktopOnly?: boolean;
  }

  const ALL_TABS: TabMeta[] = [
    {
      id: "general",
      label: "General",
      icon: SlidersHorizontalIcon,
      group: "Workspace",
    },
    {
      id: "review",
      label: "Review companion",
      icon: BinocularsIcon,
      group: "Capabilities",
    },
    {
      id: "tools",
      label: "Tools",
      icon: WrenchIcon,
      group: "Capabilities",
      desktopOnly: true,
    },
    {
      id: "skills",
      label: "Skills",
      icon: SparkleIcon,
      group: "Capabilities",
      desktopOnly: true,
    },
    {
      id: "github",
      label: "Providers",
      icon: GithubLogoIcon,
      group: "Capabilities",
      desktopOnly: true,
    },
    {
      id: "api-access",
      label: "Connections",
      icon: PlugsConnectedIcon,
      group: "Capabilities",
      desktopOnly: true,
    },
    {
      id: "keybindings",
      label: "Keybindings",
      icon: KeyboardIcon,
      group: "Input",
    },
    { id: "voice", label: "Voice", icon: MicrophoneIcon, group: "Input" },
  ];

  const tabs = $derived(
    ALL_TABS.filter((t) => !t.desktopOnly || !windowCtx.isWeb),
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

  const activeTabMeta = $derived(
    tabs.find((t) => t.id === session.settingsTab) ?? tabs[0],
  );
  const ActiveIcon = $derived(activeTabMeta.icon);

  let searchQuery = $state("");
  let searchInputEl = $state<HTMLInputElement | null>(
    null,
  );

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
  {:else if session.settingsTab === "review"}
    <SettingsTabReview {searchQuery} />
  {:else if session.settingsTab === "voice"}
    <SettingsTabVoice />
  {:else if session.settingsTab === "github"}
    <SettingsTabGitHub />
  {:else if session.settingsTab === "api-access"}
    <SettingsTabConnections />
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
      {@render tabContent()}
    </div>
  </div>
{:else}
  <div class="flex h-full overflow-hidden [--settings-header-height:3.25rem]">
    <Sidebar.Provider open={true} class="w-[13rem] shrink-0">
      <Sidebar.Root
        role="navigation"
        aria-label="Settings"
        collapsible="none"
        class="bg-[color-mix(in_srgb,var(--solus-container-bg)_90%,color-mix(in_srgb,var(--solus-input-pill-bg)_70%,var(--solus-surface-primary))_10%)] border-r border-r-(--solus-container-border)/60"
      >
        <!-- Settings forces the session sidebar closed, so this nav is the leftmost
           chrome and its header sits under the macOS traffic lights. The collapsed
           primary column publishes the lead inset; consume it here to clear them
           (a no-op off the mac editor window). -->
        <Sidebar.Content
          class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-px px-2 py-8"
        >
          {#each groupedTabs as section (section.group)}
            <Sidebar.Group
              class="p-0 first:[&_[data-sidebar=group-label]]:pt-1.5"
            >
              <Sidebar.GroupLabel
                class="h-auto text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-(--solus-text-tertiary) opacity-80 px-2.5 pt-3.5 pb-1.5"
                >{section.group}</Sidebar.GroupLabel
              >
              <Sidebar.GroupContent>
                <Sidebar.Menu class="gap-px">
                  {#each section.items as tab (tab.id)}
                    {@const Icon = tab.icon}
                    <Sidebar.MenuItem>
                      <Sidebar.MenuButton
                        type="button"
                        isActive={session.settingsTab === tab.id}
                        class="relative gap-3 h-[2.125rem] px-2.5 border-none rounded-lg bg-transparent font-normal data-[active=true]:bg-transparent data-[active=true]:font-normal cursor-pointer text-left outline-none [transition:color_0.15s_ease,background_0.15s_ease,transform_0.15s_ease]
                        {session.settingsTab === tab.id
                          ? 'text-(--solus-text-primary)'
                          : 'text-(--solus-text-tertiary) [@media(hover:hover)]:hover:text-(--solus-text-primary) [@media(hover:hover)]:hover:bg-(--solus-text-primary)/5'}"
                        aria-current={session.settingsTab === tab.id
                          ? "page"
                          : undefined}
                        onclick={() => selectTab(tab.id)}
                      >
                        <span
                          class="flex items-center shrink-0 [transition:color_0.15s_ease]
                        {session.settingsTab === tab.id
                            ? 'text-(--solus-text-primary)'
                            : 'text-(--solus-text-tertiary)'}"
                          ><Icon size={17} /></span
                        >
                        <span
                          class="text-[0.8125rem] tracking-[-0.01em] flex-1 min-w-0 text-left whitespace-nowrap overflow-hidden text-ellipsis
                        {session.settingsTab === tab.id
                            ? 'font-[650]'
                            : 'font-normal'}">{tab.label}</span
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
            class="shrink-0 flex-row items-center gap-1.5 px-3.5 py-2.5 border-t border-t-(--solus-container-border)/50 text-[0.6875rem] text-(--solus-text-tertiary) opacity-60"
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
        class="h-(--settings-header-height) border-b border-b-(--solus-container-border)/60 flex items-center justify-between gap-3 px-6 shrink-0"
      >
        <div class="flex items-center gap-2 min-w-0">
          <ActiveIcon size={16} class="text-(--solus-text-tertiary) shrink-0" />
          <h2
            class="text-[0.9375rem] font-semibold tracking-[-0.01em] text-(--solus-text-primary) truncate"
          >
            {activeTabMeta.label}
          </h2>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <div class="relative">
            <MagnifyingGlassIcon
              size={13}
              class="absolute left-2.5 top-1/2 -translate-y-1/2 text-(--solus-text-tertiary) pointer-events-none"
            />
            <Input
              bind:ref={searchInputEl}
              bind:value={searchQuery}
              type="text"
              placeholder="Search..."
              class="h-auto w-40 rounded-md border-0 bg-(--solus-input-bg-soft) py-1 pl-7 pr-3 text-[0.7813rem] shadow-[inset_0_0_0_0.0625rem_var(--solus-container-border)] [transition:box-shadow_var(--duration-base)_var(--ease-premium)] focus:shadow-[inset_0_0_0_0.0625rem_var(--solus-input-focus-border),0_0_0_0.1875rem_var(--solus-input-focus-ring)] focus-visible:ring-0 dark:bg-(--solus-input-bg-soft)"
            />
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onclick={close}
            class="text-(--solus-text-tertiary)"
          >
            <XIcon size={14} />
          </Button>
        </div>
      </header>

      <div
        class="flex-1 overflow-y-auto px-6 pt-2 pb-6"
        role="tabpanel"
        style="-webkit-overflow-scrolling:touch; overscroll-behavior-y:contain"
      >
        {@render tabContent()}
      </div>
    </div>
  </div>
{/if}
