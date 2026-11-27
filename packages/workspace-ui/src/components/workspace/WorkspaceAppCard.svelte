<script lang="ts">
  import {
    Activity as ActivityIcon,
    Copy as CopyIcon,
    Ellipsis as MenuIcon,
    FolderOpen as OpenIcon,
    Layers as VersionsIcon,
    Pin as PinIcon,
    PinOff as UnpinIcon,
    CircleAlert as ErrorIcon,
    Settings2 as ManageIcon,
    TriangleAlert as WarningIcon,
  } from "@lucide/svelte";
  import { getSettingsContext, serversStore } from "../../contexts";
  import { appPinOf, isAppPinned, withAppPinned } from "../../lib/sidebar-places";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { AppManageSection } from "../../contexts/workspace/routing/route-registry";
  import * as ContextMenu from "../ui/context-menu";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { versionLabel } from "../app/lib/app-view";
  import AppTile from "../app/AppTile.svelte";
  import { appIconsStore } from "../../contexts/apps/app-icons.store.svelte";
  import { appMonogram, appTileHue } from "@solus/client-core/app-tile";
  import { appRunStateLabel } from "../app/manage/lib/overview";
  import { calls24hText, failed24hText, type WorkspaceAppItem } from "./lib/workspace-apps";
  import { formatGeneratedFull, formatLedgerTime } from "./lib/workspace-items";
  import { highlightRuns } from "../../lib/searchHighlight";

  /**
   * One app as a card (docs/plans/apps.md §9.3, docs/workspace-page.md): its
   * tile, its name and what it does, the first thing that needs the owner, and at the
   * foot its state, its host, when it last moved, and its calls of 24 hours.
   * The card opens the app; the Manage control and the problem open the
   * Manage page.
   */
  interface Props {
    item: WorkspaceAppItem;
    selected: boolean;
    query: string;
    onOpen: () => void;
    onManage: (section?: AppManageSection) => void;
  }
  let { item, selected, query, onOpen, onManage }: Props = $props();

  const settings = getSettingsContext();
  const pin = $derived(appPinOf(item.serverId, item.appId, serversStore.hostFor(item.serverId)));
  const pinned = $derived(isAppPinned(settings.sidebarApps, pin));

  function togglePinned() {
    settings.setPersonal("sidebarApps", withAppPinned(settings.sidebarApps, pin, !pinned));
    requestInputFocus();
  }

  const titleRuns = $derived(highlightRuns(item.title, query));
  const problem = $derived(item.problems[0] ?? null);
  const failedText = $derived(failed24hText(item));
  const stateTitle = $derived(item.activeVersion === null ? appRunStateLabel(item.state) : `${appRunStateLabel(item.state)} · ${versionLabel(item.activeVersion)}`);

  /** A control inside the card acts for itself: the card does not open the app too. */
  function manage(event: MouseEvent, section?: AppManageSection) {
    event.stopPropagation();
    onManage(section);
  }

  function openMenu(event: MouseEvent) {
    event.stopPropagation();
    const button = event.currentTarget as HTMLButtonElement;
    const rect = button.getBoundingClientRect();
    button.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom,
    }));
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(item.appId);
      toasts.success("App ID copied");
    } catch {
      toasts.error("Could not copy app ID");
    }
  }
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        {...props}
        class="group relative flex min-h-[116px] min-w-0 cursor-pointer flex-col gap-1 rounded-xl bg-card px-4 pt-3.5 pb-3 text-xs transition-shadow duration-200 select-none focus-visible:outline-none {selected
          ? 'shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent),0_6px_18px_-10px_color-mix(in_oklch,var(--primary)_40%,transparent)]'
          : 'shadow-[0_0_0_.5px_var(--hairline-strong),0_1px_2px_color-mix(in_oklch,var(--foreground)_4%,transparent)] hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_20%,transparent),0_6px_18px_-10px_color-mix(in_oklch,var(--foreground)_22%,transparent)]'}"
        data-selected={selected ? "true" : null}
        data-testid="workspace-app-card"
        role="option"
        aria-selected={selected}
        tabindex="-1"
        onclick={onOpen}
      >
        <!-- The name leads. Manage waits under the pointer, as a work card's pin does. -->
        <div class="flex min-w-0 items-center gap-2">
          <AppTile monogram={appMonogram(item.app.name)} hue={appTileHue(item.app)} iconUrl={appIconsStore.urlFor(item.serverId, item.app)} />
          <span class="min-w-0 flex-1 truncate text-workspace-chrome leading-[1.35] font-medium tracking-[-0.006em] text-foreground">
            {#each titleRuns as run, i (i)}{#if run.hit}<mark class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] px-px text-inherit">{run.text}</mark>{:else}{run.text}{/if}{/each}
          </span>
          {#if item.hasUndeployedRevision}
            <span class="shrink-0 rounded-full bg-[var(--wash-2)] px-1.5 py-px text-muted-foreground" title="The newest revision waits for a deploy" data-testid="workspace-app-undeployed">Undeployed</span>
          {/if}
          <Button
            variant="ghost"
            size="icon-xs"
            class="-my-1 -mr-1.5 shrink-0 text-muted-foreground transition-opacity duration-150 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 {selected ? 'opacity-100' : 'opacity-0'}"
            aria-label="Manage {item.title}"
            title="Manage"
            onclick={(event: MouseEvent) => manage(event)}
            data-testid="workspace-app-manage"
          >
            <ManageIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            class="-my-1 -mr-1.5 shrink-0 text-muted-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 {selected ? 'opacity-100' : 'opacity-0'}"
            aria-label="Options for {item.title}"
            aria-haspopup="menu"
            title="App options"
            onclick={openMenu}
            data-testid="workspace-app-options"
          >
            <MenuIcon />
          </Button>
        </div>

        {#if item.description}
          <p class="m-0 line-clamp-2 leading-[1.45] text-muted-foreground text-pretty">{item.description}</p>
        {/if}

        <!-- The foot sits at the bottom, so the feet of a row of cards align. -->
        <div class="mt-auto flex min-w-0 flex-col gap-1.5 pt-2">
          {#if problem}
            <button
              type="button"
              class="flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 self-start overflow-hidden rounded-sm border-0 bg-transparent p-0 text-left text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
              title={item.problems.map((each) => `${each.detail} ${each.action}.`).join("\n")}
              data-tone={problem.tone}
              data-testid="workspace-app-problem"
              onclick={(event) => manage(event, problem.section)}
            >
              {#if problem.tone === "error"}
                <ErrorIcon size={12} class="shrink-0 text-destructive" aria-hidden="true" />
              {:else}
                <WarningIcon size={12} class="shrink-0 text-(--warning)" aria-hidden="true" />
              {/if}
              <span class="min-w-0 truncate">{problem.detail}</span>
              {#if item.problems.length > 1}
                <span class="shrink-0 tabular-nums opacity-70">+{item.problems.length - 1}</span>
              {/if}
            </button>
          {/if}

          <span class="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <!-- Running is the usual state: the card shows no mark for it. Any other state is named. -->
            {#if item.state === "running"}
              <span class="sr-only" data-testid="workspace-app-state" data-state={item.state}>{appRunStateLabel(item.state)}</span>
            {:else}
              <span class="shrink-0" title={stateTitle} data-testid="workspace-app-state" data-state={item.state}>{appRunStateLabel(item.state)} ·</span>
            {/if}
            <span class="min-w-0 truncate" title={item.state === "running" ? stateTitle : undefined} data-testid="workspace-app-host">{item.hostLabel}</span>
            <span class="shrink-0 tabular-nums" title="Last activity {formatGeneratedFull(item.timestamp)}">· {formatLedgerTime(item.timestamp)}</span>
            <span class="flex-1"></span>
            <span class="shrink-0 tabular-nums" title="In the last 24 hours" data-testid="workspace-app-calls">
              {calls24hText(item)}{#if failedText}{" · "}<span class="text-destructive">{failedText}</span>{/if}
            </span>
          </span>
        </div>
      </div>

    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Content class="min-w-48" data-testid="workspace-app-context-menu">
    <ContextMenu.Item onSelect={onOpen}><OpenIcon />Open app</ContextMenu.Item>
    <ContextMenu.Item onSelect={() => onManage()}><ManageIcon />Manage app</ContextMenu.Item>
    <ContextMenu.Separator />
    <ContextMenu.Item onSelect={() => onManage("activity")}><ActivityIcon />View activity</ContextMenu.Item>
    <ContextMenu.Item onSelect={() => onManage("versions")}><VersionsIcon />View versions</ContextMenu.Item>
    <ContextMenu.Separator />
    <ContextMenu.Item onSelect={togglePinned} data-testid="workspace-app-toggle-pinned">
      {#if pinned}<UnpinIcon />Unpin from sidebar{:else}<PinIcon />Pin to sidebar{/if}
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={() => void copyId()}><CopyIcon />Copy app ID</ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
