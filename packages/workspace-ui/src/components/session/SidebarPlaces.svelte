<script lang="ts">
  /** The places column of the sidebar: Sessions, Workspace, Automations,
   *  Insights, Pull requests, Tasks, and Search as icon buttons down the left
   *  edge, with the account footer at its foot. With the sidebar collapsed the
   *  pane stops at this column, so it stays on screen alone (`WorkspaceBody`). These are static places, not tasks, so they
   *  stay out of the list and the sessions start at the top of the sidebar.
   *  Each button names itself in its tooltip, with its shortcut
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
  import { getPullRequestsContext, getWorkspaceContext, hosts } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { frameChrome } from "../layout/frame-chrome.store.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { Button } from "../ui/button";
  import TaskIcon from "../ui/TaskIcon.svelte";
  import * as TooltipUI from "../ui/tooltip";
  import SidebarAccountFooter from "./SidebarAccountFooter.svelte";

  const session = getWorkspaceContext();
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
</script>

<!-- The selected place is drawn as the selected session row is: a raised card.
     `reviewCount` is a static total in the same muted numerals as every other
     count in the column. A filled badge here would compete with the status
     marks in the list, which are what the eye is meant to count. -->
{#snippet place(
  label: string,
  shortcut: string | undefined,
  isActive: boolean,
  onclick: () => void,
  icon: typeof BooksIcon | typeof TaskIcon,
  reviewCount: number = 0,
  reviewLabel: string = "",
  countTestId: string | undefined = undefined,
)}
  {@const Icon = icon}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-sm"
          aria-label={reviewCount > 0 ? `${label}, ${reviewLabel}` : label}
          aria-current={isActive ? "page" : undefined}
          class="relative size-8 rounded-lg text-[color-mix(in_oklch,var(--foreground)_65%,transparent)] hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground pointer-coarse:size-10 {isActive
            ? 'bg-card text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_10%,transparent),0_2px_6px_color-mix(in_oklch,var(--foreground)_8%,transparent)] hover:bg-card dark:bg-[color-mix(in_oklch,var(--card)_94%,white)] dark:hover:bg-[color-mix(in_oklch,var(--card)_94%,white)]'
            : ''}"
          {onclick}
        >
          <Icon size={16} />
          {#if reviewCount > 0}
            <span
              class="pointer-events-none absolute top-0.5 right-0.5 text-[0.5625rem] leading-none font-medium text-muted-foreground tabular-nums opacity-70"
              data-testid={countTestId}
              aria-hidden="true">{reviewCount > 99 ? "99+" : reviewCount}</span
            >
          {/if}
        </Button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content
      side="right"
      value={{ label: reviewCount > 0 ? `${label} · ${reviewLabel}` : label, shortcut }}
    />
  </TooltipUI.Root>
{/snippet}

<div class="relative flex w-11 shrink-0 flex-col items-center gap-1 pb-2">
  <!-- The hairline beside the list. It fades in at the top, where the sky
       runs into the sidebar, so the sky has no line across it, and it fades
       out the same distance above the foot of the column. A collapsed sidebar
       keeps it as the divider beside the content. -->
  <div
    class="pointer-events-none absolute inset-y-0 right-0 w-[0.03125rem] bg-[linear-gradient(to_bottom,transparent,var(--color-sidebar-border)_3.5rem,var(--color-sidebar-border)_calc(100%-3.5rem),transparent)]"
    aria-hidden="true"
  ></div>
  <nav aria-label="Places" class="flex flex-col items-center gap-1">
    {@render place("Sessions", undefined, atSessions, showSessions, SessionsIcon)}
    {#if !isGuest}
      {@render place(
        "Workspace",
        comboHint("global.toggle-workspace"),
        session.router.at("folio"),
        () => session.toggleFolio(),
        BooksIcon,
        reviewInboxCount,
        `${reviewInboxCount} ${reviewInboxCount === 1 ? "work needs" : "works need"} your review`,
        "work-review-inbox-count",
      )}
      {@render place(
        "Automations",
        comboHint("global.toggle-automations"),
        session.router.at("automations"),
        () => session.toggleAutomations(),
        ArrowsClockwiseIcon,
      )}
      {@render place(
        "Insights",
        comboHint("global.toggle-insights"),
        session.router.at("insights"),
        () => session.toggleInsights(),
        ChartBarIcon,
      )}
      {@render place(
        "Pull requests",
        undefined,
        session.router.at("prs"),
        togglePrs,
        GitPullRequestIcon,
        needsReviewCount,
        `${needsReviewCount} ${needsReviewCount === 1 ? "needs" : "need"} your review`,
      )}
      {@render place(
        "Tasks",
        comboHint("global.toggle-tasks"),
        session.router.at("tasks"),
        () => session.toggleTasks(),
        TaskIcon,
      )}
    {/if}
    {@render place(
      "Search",
      comboHint("global.session-picker"),
      false,
      () => window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
      SearchIcon,
    )}
  </nav>
  <div class="mt-auto flex flex-col items-center gap-1">
    <SidebarAccountFooter />
  </div>
</div>
