<script lang="ts">
  /** The places column of the sidebar: Sessions, then the Solus places
   *  (Workspace, Automations, Insights, Pull requests, Tasks, and Search) as
   *  icon buttons down the left edge, then a divider and the apps the person
   *  pinned, with the account footer at its foot. With the sidebar collapsed
   *  the pane stops at this column, so it stays on screen alone
   *  (`WorkspaceBody`). These are static places, not tasks, so they stay out
   *  of the list and the sessions start at the top of the sidebar. Each button
   *  names itself in its tooltip, with its shortcut. The person orders, hides,
   *  and pins from the column's menu (a right-click) or by drag
   *  (docs/plans/sidebar-places-and-sky.md). */
  import { untrack } from "svelte";
  import {
    LibraryBig as BooksIcon,
    Search as SearchIcon,
    RefreshCw as ArrowsClockwiseIcon,
    ChartBar as ChartBarIcon,
    GitPullRequest as GitPullRequestIcon,
    MessagesSquare as SessionsIcon,
  } from "@lucide/svelte";
  import { projectScopeOf } from "@solus/contracts/types";
  import { getPullRequestsContext, getSettingsContext, getWorkspaceContext, hosts, serversStore } from "../../contexts";
  import { appsStore, type AppRow } from "../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    SIDEBAR_PLACES,
    appMenuTarget,
    dropLineY,
    dropTargetAt,
    insertionIndex,
    appPinOf,
    isSamePin,
    pinnedRows,
    placeMenuTarget,
    shownPlaces,
    withAppMoved,
    withPlaceMoved,
    type SidebarAppPin,
    type SidebarPlaceId,
    type SidebarPlacesMenuTarget,
  } from "../../lib/sidebar-places";
  import { appMonogram, appTileHue } from "@solus/client-core/app-tile";
  import AppTile from "../app/AppTile.svelte";
  import { frameChrome } from "../layout/frame-chrome.store.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { pointAnchor, type PanelMenuAnchor } from "../project-panel/lib/panel-items";
  import { Button } from "../ui/button";
  import TaskIcon from "../ui/TaskIcon.svelte";
  import * as TooltipUI from "../ui/tooltip";
  import SidebarAccountFooter from "./SidebarAccountFooter.svelte";
  import SidebarPlacesMenu from "./SidebarPlacesMenu.svelte";

  interface PlaceButton {
    label: string;
    shortcut?: string;
    isActive: boolean;
    onclick: () => void;
    icon?: typeof BooksIcon | typeof TaskIcon;
    /** A pinned app's letter, in place of an icon, on a tile of the app's own hue. */
    monogram?: string;
    monogramHue?: number;
    reviewCount?: number;
    reviewLabel?: string;
    countTestId?: string;
  }

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  // A share link's guest reads only the shared session: the workspace pages are not theirs (host-sharing.md §10).
  const isGuest = $derived(hosts.runOn?.me.isGuest ?? false);
  const pullRequests = getPullRequestsContext();
  const needsReviewCount = $derived(
    pullRequests.needsReview.countFor(
      session.serverIdForContext(session.ctx),
      session.ctx,
    ),
  );
  // Keyed on the host and the project alone: `session.ctx` is a new object on
  // every session event, and the interest only changes with these two.
  const needsReviewServerId = $derived(session.serverIdForContext(session.ctx));
  const needsReviewScope = $derived(projectScopeOf(session.ctx.session));
  $effect(() => {
    void needsReviewServerId;
    void needsReviewScope;
    return untrack(() => pullRequests.needsReview.wantShown(session));
  });
  // Works a teammate asked the reader to review, on every host.
  const reviewInboxCount = $derived(session.worksStore.reviews.inbox.length);

  // A guest keeps Search, whatever the owner's column holds.
  const places = $derived(
    isGuest ? SIDEBAR_PLACES.filter((place) => place.id === "search") : shownPlaces(settings.sidebarPlaces),
  );
  const pinOfRow = (row: AppRow) => appPinOf(row.serverId, row.app.id, serversStore.hostFor(row.serverId));
  const pinnedApps = $derived(isGuest ? [] : pinnedRows(settings.sidebarApps, appsStore.rows, pinOfRow));
  // The pinned apps need the app lists of the hosts; with no pin, no list is read.
  const hasPins = $derived(!isGuest && settings.sidebarApps.length > 0);
  $effect(() => {
    if (hasPins) return appsStore.watch();
  });

  // Sessions is where you are when a conversation or a new draft is on screen,
  // with no page and no Settings over it.
  const showsSession = $derived(
    session.router.destination.name === "chat" || session.router.destination.name === "draft",
  );
  const atSessions = $derived(showsSession && !session.router.at("settings"));

  /** Back to the conversation from a page or Settings. Already there, it opens
   *  the session list when the sidebar is collapsed. */
  function showSessions() {
    if (session.router.at("settings")) session.router.close("settings");
    if (!showsSession) session.router.close(session.router.destination.name);
    else if (!frameChrome.sidebarOpen) frameChrome.expandSidebar?.();
    requestInputFocus();
  }

  function togglePrs() {
    session.togglePrs();
    requestInputFocus();
  }

  function placeButton(id: SidebarPlaceId): PlaceButton {
    switch (id) {
      case "workspace":
        return {
          label: "Workspace",
          shortcut: comboHint("global.toggle-workspace"),
          isActive: session.router.at("folio"),
          onclick: () => session.toggleFolio(),
          icon: BooksIcon,
          reviewCount: reviewInboxCount,
          reviewLabel: `${reviewInboxCount} ${reviewInboxCount === 1 ? "work needs" : "works need"} your review`,
          countTestId: "work-review-inbox-count",
        };
      case "automations":
        return {
          label: "Automations",
          shortcut: comboHint("global.toggle-automations"),
          isActive: session.router.at("automations"),
          onclick: () => session.toggleAutomations(),
          icon: ArrowsClockwiseIcon,
        };
      case "insights":
        return {
          label: "Insights",
          shortcut: comboHint("global.toggle-insights"),
          isActive: session.router.at("insights"),
          onclick: () => session.toggleInsights(),
          icon: ChartBarIcon,
        };
      case "prs":
        return {
          label: "Pull requests",
          isActive: session.router.at("prs"),
          onclick: togglePrs,
          icon: GitPullRequestIcon,
          reviewCount: needsReviewCount,
          reviewLabel: `${needsReviewCount} ${needsReviewCount === 1 ? "needs" : "need"} your review`,
        };
      case "tasks":
        return {
          label: "Tasks",
          shortcut: comboHint("global.toggle-tasks"),
          isActive: session.router.at("tasks"),
          onclick: () => session.toggleTasks(),
          icon: TaskIcon,
        };
      case "search":
        return {
          label: "Search",
          shortcut: comboHint("global.session-picker"),
          isActive: false,
          onclick: () => window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
          icon: SearchIcon,
        };
    }
  }

  /** The app is the destination: its own view or its Manage page. */
  function isAppOnScreen(row: AppRow): boolean {
    const destination = session.router.destination;
    if (destination.name !== "app") return false;
    const { serverId, slug } = destination.params;
    return (serverId === undefined || serverId === row.serverId) && (slug === row.app.slug || slug === row.app.id);
  }

  function appButton(row: AppRow): PlaceButton {
    const isActive = isAppOnScreen(row);
    return {
      label: row.app.name,
      isActive,
      onclick: () => {
        if (!isActive) {
          session.openApp(row.serverId, row.app.slug, "leading");
          return;
        }
        session.router.close("app");
        requestInputFocus();
      },
      monogram: appMonogram(row.app.name),
      monogramHue: appTileHue(row.app),
    };
  }

  // ─── The column's menu ───

  let menuOpen = $state(false);
  let menuAnchor = $state<PanelMenuAnchor | null>(null);
  let menuTarget = $state<SidebarPlacesMenuTarget | null>(null);

  /** The row an event is on, as the menu names it. Sessions and the footer are not rows of the menu. */
  function targetOf(element: EventTarget | null): SidebarPlacesMenuTarget | null {
    const row = element instanceof Element ? element.closest<HTMLElement>("[data-place-index], [data-app-index]") : null;
    if (!row) return null;
    if (row.dataset.placeIndex !== undefined) return placeMenuTarget(places, Number(row.dataset.placeIndex));
    const pinned = pinnedApps.map(({ pin, row: app }) => ({ pin, label: app.app.name }));
    return appMenuTarget(pinned, Number(row.dataset.appIndex));
  }

  /** A text field keeps its own menu (spelling, paste). */
  function isTextField(element: EventTarget | null): boolean {
    return element instanceof Element && !!element.closest("input, textarea, [contenteditable]");
  }

  function openMenuAt(event: MouseEvent) {
    if (isGuest || isTextField(event.target)) return;
    event.preventDefault();
    menuTarget = targetOf(event.target);
    menuAnchor = pointAnchor(event.clientX, event.clientY);
    menuOpen = true;
  }

  function openMenuFromKeyboard(event: KeyboardEvent) {
    if (isGuest || isTextField(event.target) || (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey))) return;
    event.preventDefault();
    menuTarget = targetOf(event.target);
    menuAnchor = event.target instanceof HTMLElement ? event.target : null;
    menuOpen = true;
  }

  // ─── Drag to reorder, within the places or within the pinned apps ───

  let dragged = $state<{ kind: "place"; id: SidebarPlaceId } | { kind: "app"; pin: SidebarAppPin } | null>(null);

  function startDrag(event: DragEvent, item: NonNullable<typeof dragged>) {
    if (isGuest) return;
    dragged = item;
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  // The whole column takes the drop, so a release below the last button, or
  // in a gap, still lands. The gap is the pointer's height against the middle
  // of each button of the dragged one's group.
  let column = $state<HTMLElement | null>(null);
  let dropGap = $state<number | null>(null);
  let dropLineTop = $state<number | null>(null);

  function groupButtons(kind: "place" | "app"): DOMRect[] {
    const selector = kind === "place" ? "[data-place-index]" : "[data-app-index]";
    return column ? [...column.querySelectorAll(selector)].map((element) => element.getBoundingClientRect()) : [];
  }

  function dragOverColumn(event: DragEvent) {
    if (!dragged || !column) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const buttons = groupButtons(dragged.kind);
    dropGap = insertionIndex(buttons, event.clientY);
    const lineY = dropLineY(buttons, dropGap);
    dropLineTop = lineY === null ? null : lineY - column.getBoundingClientRect().top;
  }

  function leaveColumn(event: DragEvent) {
    if (event.relatedTarget instanceof Node && column?.contains(event.relatedTarget)) return;
    dropGap = null;
    dropLineTop = null;
  }

  function dropOnColumn(event: DragEvent) {
    if (!dragged || dropGap === null) return;
    event.preventDefault();
    if (dragged.kind === "place") {
      const shown = places.map((place) => place.id);
      const target = dropTargetAt(shown, shown.indexOf(dragged.id), dropGap);
      if (target) settings.setPersonal("sidebarPlaces", withPlaceMoved(settings.sidebarPlaces, dragged.id, target));
    } else {
      const shown = pinnedApps.map(({ pin }) => pin);
      const draggedPin = dragged.pin;
      const target = dropTargetAt(shown, shown.findIndex((pin) => isSamePin(pin, draggedPin)), dropGap);
      if (target) settings.setPersonal("sidebarApps", withAppMoved(settings.sidebarApps, draggedPin, target));
    }
    endDrag();
  }

  function endDrag() {
    dragged = null;
    dropGap = null;
    dropLineTop = null;
  }
</script>

<!-- The selected place is drawn as the selected session row is: a raised card.
     `reviewCount` is a static total in the same muted numerals as every other
     count in the column. A filled badge here would compete with the status
     marks in the list, which are what the eye is meant to count. -->
{#snippet place(button: PlaceButton)}
  {@const Icon = button.icon}
  {@const reviewCount = button.reviewCount ?? 0}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-sm"
          aria-label={reviewCount > 0 ? `${button.label}, ${button.reviewLabel}` : button.label}
          aria-current={button.isActive ? "page" : undefined}
          class="relative size-8 rounded-lg text-[color-mix(in_oklch,var(--foreground)_65%,transparent)] hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground pointer-coarse:size-10 {button.isActive
            ? 'bg-card text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_10%,transparent),0_2px_6px_color-mix(in_oklch,var(--foreground)_8%,transparent)] hover:bg-card dark:bg-[color-mix(in_oklch,var(--card)_94%,white)] dark:hover:bg-[color-mix(in_oklch,var(--card)_94%,white)]'
            : ''}"
          onclick={button.onclick}
        >
          {#if Icon}
            <Icon size={16} />
          {:else}
            <AppTile monogram={button.monogram ?? "?"} hue={button.monogramHue ?? 0} />
          {/if}
          {#if reviewCount > 0}
            <span
              class="pointer-events-none absolute top-0.5 right-0.5 text-[0.5625rem] leading-none font-medium text-muted-foreground tabular-nums opacity-70"
              data-testid={button.countTestId}
              aria-hidden="true">{reviewCount > 99 ? "99+" : reviewCount}</span
            >
          {/if}
        </Button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content
      side="right"
      value={{ label: reviewCount > 0 ? `${button.label} · ${button.reviewLabel}` : button.label, shortcut: button.shortcut }}
    />
  </TooltipUI.Root>
{/snippet}

<!-- A right-click or the context-menu key anywhere in the column opens the
     column's menu: on a button, in the empty space, or on the footer. On a
     place or a pinned app, the menu first acts on that button. -->
<div
  bind:this={column}
  class="relative flex w-11 shrink-0 flex-col items-center gap-1 pb-2"
  role="presentation"
  oncontextmenu={openMenuAt}
  onkeydown={openMenuFromKeyboard}
  ondragover={dragOverColumn}
  ondragleave={leaveColumn}
  ondrop={dropOnColumn}
>
  {#if dropLineTop !== null}
    <!-- Where the dragged button lands. -->
    <div
      class="pointer-events-none absolute inset-x-2.5 z-10 h-px -translate-y-1/2 rounded-full bg-[color-mix(in_oklch,var(--foreground)_30%,transparent)]"
      style:top="{dropLineTop}px"
      aria-hidden="true"
    ></div>
  {/if}
  <!-- The hairline beside the list. It fades in at the top, where the sky
       runs into the sidebar, so the sky has no line across it, and it fades
       out the same distance above the foot of the column. A collapsed sidebar
       keeps it as the divider beside the content. -->
  <div
    class="pointer-events-none absolute inset-y-0 right-0 w-[0.03125rem] bg-[linear-gradient(to_bottom,transparent,var(--color-sidebar-border)_3.5rem,var(--color-sidebar-border)_calc(100%-3.5rem),transparent)]"
    aria-hidden="true"
  ></div>
  <div class="flex min-h-0 flex-col items-center gap-1">
    <nav aria-label="Places" class="flex flex-col items-center gap-1">
      {@render place({ label: "Sessions", isActive: atSessions, onclick: showSessions, icon: SessionsIcon })}
      {#each places as item, index (item.id)}
        <div
          role="presentation"
          data-place-index={index}
          draggable={!isGuest}
          class="flex {dragged?.kind === 'place' && dragged.id === item.id ? 'opacity-50' : ''}"
          ondragstart={(event) => startDrag(event, { kind: "place", id: item.id })}
          ondragend={endDrag}
        >
          {@render place(placeButton(item.id))}
        </div>
      {/each}
    </nav>
    {#if pinnedApps.length > 0}
      <!-- Solus places above, the person's apps below. -->
      <div role="separator" aria-orientation="horizontal" class="my-1 h-px w-5 shrink-0 bg-sidebar-border"></div>
      <!-- Many pins scroll here; the places above and the footer stay. -->
      <nav
        aria-label="Pinned apps"
        class="flex min-h-0 w-11 flex-col items-center gap-1 overflow-y-auto pt-0.5 pb-2.5 [scrollbar-width:none]"
        data-testid="sidebar-pinned-apps"
      >
        {#each pinnedApps as { pin, row }, index (`${pin.host}\n${pin.appId}`)}
          <div
            role="presentation"
            data-app-index={index}
            draggable="true"
            class="flex {dragged?.kind === 'app' && isSamePin(dragged.pin, pin) ? 'opacity-50' : ''}"
            ondragstart={(event) => startDrag(event, { kind: "app", pin })}
            ondragend={endDrag}
          >
            {@render place(appButton(row))}
          </div>
        {/each}
      </nav>
    {/if}
  </div>
  <div class="mt-auto flex flex-col items-center gap-1">
    <SidebarAccountFooter />
  </div>
</div>

<SidebarPlacesMenu bind:open={menuOpen} anchor={menuAnchor} target={menuTarget} />
