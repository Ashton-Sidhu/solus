<script lang="ts">
  import {
    PlusIcon,
    GearIcon,
    ArticleIcon,
    FileTextIcon,
    ClockIcon,
    XIcon,
    PushPinIcon,
  } from "phosphor-svelte";
  import { getWorkspaceContext, getSessionSidebarStore } from "@renderer/contexts";
  import { requestInputFocus } from "@renderer/lib/inputFocus";
  import { getAttentionIcon, attentionLabel, type AttentionState } from "@renderer/lib/sessionUtils";

  interface Props {
    /** Close the drawer after a navigation action. */
    onSessionSelect: () => void;
  }
  let { onSessionSelect }: Props = $props();

  const session = getWorkspaceContext();
  const store = getSessionSidebarStore();

  // Flatten the project → branch → tab tree into one large row per open session,
  // keeping project/branch context as secondary text. A flat list of big tap
  // targets is far easier to scan and hit on a phone than the desktop tree.
  const groups = $derived(store.projectBranchGroups);
  const hasSessions = $derived(groups.length > 0);

  // Shared row shell — keeps pinned + session rows visually identical.
  const rowBase =
    "group relative flex items-center gap-2.5 w-full min-h-[3.25rem] py-2 pr-1.5 pl-3.5 rounded-[0.875rem] text-left cursor-pointer [-webkit-tap-highlight-color:transparent] transition-colors duration-100";
  const sectionLabel =
    "first:pt-2 px-3.5 pt-[1.125rem] pb-1 text-[0.75rem] font-normal text-(--solus-text-tertiary) truncate";

  function selectTab(tabId: string) {
    store.selectTab(tabId);
    requestInputFocus();
    onSessionSelect();
  }

  function closeTab(tabId: string, e: Event) {
    e.stopPropagation();
    store.closeTabs([tabId]);
  }

  function newSession() {
    void session.createTab();
    requestInputFocus();
    onSessionSelect();
  }

  function nav(action: () => void) {
    action();
    onSessionSelect();
  }
</script>

{#snippet attentionMark(att: AttentionState)}
  {#if att === "unread"}
    <span class="shrink-0 w-2 h-2 rounded-full bg-(--solus-accent)" aria-label="unread"></span>
  {:else}
    {@const icon = getAttentionIcon(att)}
    {#if icon}
      {@const Icon = icon.component}
      <span
        class="shrink-0 flex items-center {icon.spin ? 'animate-spin' : ''}"
        style="color:{icon.color}"
        aria-label={attentionLabel(att) || undefined}
      >
        <Icon size={13} weight="bold" />
      </span>
    {/if}
  {/if}
{/snippet}

{#snippet activeBar()}
  <span class="absolute left-1 top-1/2 -translate-y-1/2 h-5 w-[0.1875rem] rounded-full bg-(--solus-accent)"></span>
{/snippet}

<div class="flex flex-col h-full min-h-0">
  <header
    class="shrink-0 flex items-center justify-between px-4 pb-3 pt-[max(0.875rem,env(safe-area-inset-top,0px))]"
  >
    <span class="text-[1.125rem] font-medium tracking-[-0.01em] text-(--solus-text-primary)">Sessions</span>
    <button
      class="flex items-center gap-1 rounded-full border-0 bg-(--solus-accent-light) py-1.5 pl-2.5 pr-3 text-[0.8125rem] font-medium text-(--solus-accent) cursor-pointer transition-colors duration-100 active:bg-(--solus-accent-border-medium) [-webkit-tap-highlight-color:transparent]"
      onclick={newSession}
      aria-label="New session"
    >
      <PlusIcon size={17} weight="bold" />
      <span>New</span>
    </button>
  </header>

  <div class="flex-1 min-h-0 overflow-y-auto overscroll-y-contain px-2 pt-0.5 pb-3 [-webkit-overflow-scrolling:touch]">
    {#if store.pinnedSessions.length > 0}
      <div class={sectionLabel}>Pinned</div>
      {#each store.pinnedSessions as pin (pin.sessionId)}
        {@const openTabId = store.openTabIdForPinned(pin)}
        {@const isActive = !!openTabId && openTabId === session.activeTabId}
        <button
          class="{rowBase} {isActive ? 'bg-(--solus-accent-light)' : 'bg-transparent active:bg-(--solus-surface-hover)'}"
          onclick={() => nav(() => store.openPinnedSession(pin))}
        >
          {#if isActive}{@render activeBar()}{/if}
          <span class="shrink-0 flex items-center {isActive ? 'text-(--solus-accent)' : 'text-(--solus-text-tertiary)'}"><PushPinIcon size={14} weight="fill" /></span>
          <span class="flex-1 min-w-0 truncate text-[0.8125rem] font-normal {isActive ? 'text-(--solus-accent)' : 'text-(--solus-text-primary)'}">{pin.title}</span>
        </button>
      {/each}
    {/if}

    {#if hasSessions}
      {#each groups as group (group.projectKey)}
        <div class={sectionLabel}>{group.projectLabel}</div>
        {#each group.branches as branch (branch.key)}
          {@const multiBranch = group.branches.length > 1 || branch.tabIds.length > 1}
          {#each branch.tabIds as tabId (tabId)}
            {@const child = store.childForTab(tabId)}
            <div
              class="{rowBase} {child.active ? 'bg-(--solus-accent-light)' : 'bg-transparent active:bg-(--solus-surface-hover)'}"
              role="button"
              tabindex="0"
              data-active={child.active ? "true" : undefined}
              onclick={() => selectTab(tabId)}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectTab(tabId);
                }
              }}
            >
              {#if child.active}{@render activeBar()}{/if}
              <span class="flex-1 min-w-0 flex flex-col gap-px">
                <span class="truncate text-[0.8125rem] leading-tight font-normal {child.active ? 'text-(--solus-accent)' : 'text-(--solus-text-primary)'}">{child.label}</span>
                {#if multiBranch}
                  <span class="truncate text-[0.6875rem] leading-tight text-(--solus-text-tertiary)">{branch.label}</span>
                {/if}
              </span>
              {#if child.attention}
                {@render attentionMark(child.attention)}
              {/if}
              <button
                class="shrink-0 w-9 h-9 flex items-center justify-center rounded-full border-0 bg-transparent text-(--solus-text-muted) cursor-pointer transition-colors duration-100 active:bg-(--solus-surface-tertiary) active:text-(--solus-text-secondary) [-webkit-tap-highlight-color:transparent]"
                aria-label="Close session"
                onclick={(e) => closeTab(tabId, e)}
              >
                <XIcon size={15} />
              </button>
            </div>
          {/each}
        {/each}
      {/each}
    {:else}
      <div class="flex flex-col items-center gap-3 px-4 py-12 text-[0.8125rem] text-(--solus-text-tertiary)">
        <span>No open sessions</span>
        <button
          class="flex items-center gap-1.5 rounded-full border-0 bg-(--solus-accent-light) px-4 py-2 text-[0.8125rem] font-medium text-(--solus-accent) cursor-pointer active:bg-(--solus-accent-border-medium)"
          onclick={newSession}
        >
          <PlusIcon size={15} weight="bold" /> New session
        </button>
      </div>
    {/if}
  </div>

  <footer
    class="shrink-0 flex gap-0.5 border-t border-(--solus-container-border) px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
  >
    {#snippet footBtn(label: string, Icon: typeof GearIcon, action: () => void)}
      <button
        class="flex-1 min-w-0 flex flex-col items-center gap-1 rounded-[0.625rem] border-0 bg-transparent px-1 py-2 text-[0.625rem] font-medium text-(--solus-text-tertiary) cursor-pointer transition-colors duration-100 active:bg-(--solus-surface-hover) active:text-(--solus-text-secondary) [-webkit-tap-highlight-color:transparent]"
        onclick={() => nav(action)}
      >
        <Icon size={18} /><span>{label}</span>
      </button>
    {/snippet}
    {@render footBtn("Plans", ArticleIcon, () => session.togglePlansGallery())}
    {@render footBtn("Folio", FileTextIcon, () => session.toggleFolioGallery())}
    {@render footBtn("History", ClockIcon, () => window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")))}
    {@render footBtn("Settings", GearIcon, () => session.showSettings())}
  </footer>
</div>
