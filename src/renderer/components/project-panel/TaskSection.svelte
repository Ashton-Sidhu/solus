<script lang="ts">
  import { CaretDownIcon, ColumnsIcon, PlusIcon } from "phosphor-svelte";
  import type { Task, TaskLink } from "../../../shared/task-types";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    attemptServerId,
    findOpenTabForSession,
    getAttentionState,
    openSessionFor,
    sessionTitle,
  } from "../../lib/sessionUtils";
  import { toasts } from "../../lib/toasts";
  import { serverConnections } from "@client-core/server-connections";
  import { readSessionMeta } from "@client-core/session-meta";
  import * as TooltipUI from "../ui/tooltip";
  import {
    orderSessionLinks,
    railLinkList,
    railSessionRow,
  } from "./lib/rail-task-card";
  import { linkedPrNavigationTarget } from "../tasks/task-page/lib/linked-pr-navigation";

  interface Props {
    /** The task the rail's session is working. */
    task: Task;
    /** Project the task belongs to — GitHub detail reads are routed by it. */
    projectCwd?: string;
    /** The attempt the rail is describing, which leads the Sessions group and
     *  carries a resting wash so it reads as the one you are in. */
    currentSessionId?: string | null;
    /** False while this mounted tab's project rail is not on screen. */
    active?: boolean;
  }
  let { task, projectCwd, currentSessionId = null, active = true }: Props = $props();

  const session = getWorkspaceContext();
  const store = session.tasksStore;

  /** Six rows, then a named tail. Expanding does not collapse again — a user
   *  who asked for the whole list is not asking to hide it a moment later. */
  const CAP = 6;
  let expanded = $state(false);

  // Elapsed on a running row is a live reading, so the clock the rows are
  // shaped against has to move. A derived can't tick, which is what $effect is
  // for; the interval only exists while something is actually running.
  let now = $state(Date.now());

  // Links and attempts live on the task's detail record; the list load only
  // carries the task row, so the card fetches its own detail below.
  const details = $derived(store.detailsFor(task.id));
  const links = $derived(details?.links ?? []);
  const linkList = $derived(
    railLinkList(
      links,
      expanded ? Number.MAX_SAFE_INTEGER : CAP,
      (id) => session.automationsStore.get(id),
      now,
    ),
  );

  // One store getter returns the same nested sessions the sidebar shows.
  const attempts = $derived(
    orderSessionLinks(store.attemptsForTask(task.id), currentSessionId),
  );
  // Only "what is this session doing right now" is read live — everything else
  // comes off the link, so a closed attempt still renders a full row. The live
  // read is its own derived so the ticking clock below can't invalidate it.
  const liveAttempts = $derived(
    attempts.map((link) => {
      const attemptTask = store.taskForId(link.taskId) ?? task;
      const open = openSessionFor(
        link.sessionId,
        attemptServerId({
          link,
          taskServerId: store.hostFor(attemptTask.id),
        }),
        session,
      );
      return {
        link,
        task: attemptTask,
        title: open ? sessionTitle(open.session) : null,
        attention: open ? getAttentionState(open.session, open.tab) : null,
      };
    }),
  );

  const sessionRows = $derived(
    liveAttempts.map((attempt) =>
      railSessionRow(
        attempt.link,
        attempt.title,
        attempt.attention,
        attempt.link.sessionId === currentSessionId,
        now,
        attempt.task.title,
      ),
    ),
  );

  $effect(() => {
    if (!liveAttempts.some((attempt) => attempt.attention === "running")) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  // Details are per-task IO, so this is one of the cases $effect is for. The
  // rail follows whichever session is focused, so the id it wants changes
  // without any click of its own.
  let loadedTaskId: string | null = null;
  $effect(() => {
    const id = task.id;
    if (!active) {
      loadedTaskId = null;
      return;
    }
    const stopWatching = store.watchDetails(id);
    if (id !== loadedTaskId) {
      loadedTaskId = id;
      void store.loadDetails(id, projectCwd).catch(() => {});
    }
    return stopWatching;
  });

  /** Focus the session's tab when it's already open, otherwise resume it from
   *  history. Resolve the indexed record first: the link stores a session id,
   *  not which agent backend wrote it. */
  async function reveal(sessionId: string): Promise<string | null> {
    const link = attempts.find((candidate) => candidate.sessionId === sessionId);
    const serverId = link?.executionServerId ??
      (link ? store.hostFor(link.taskId) : null);
    const openTab = findOpenTabForSession(
      sessionId,
      session.tabs,
      session.sessions,
      session.tabOrder,
      undefined,
      serverId ? serverConnections.resolveId(serverId) : undefined,
    );
    if (openTab) return openTab;
    const meta = serverId ? await readSessionMeta(serverId, sessionId) : null;
    return meta ? await session.resumeSession(meta) : null;
  }

  async function openSession(sessionId: string) {
    const tabId = await reveal(sessionId);
    if (tabId) session.selectTab(tabId);
    requestInputFocus();
  }

  async function openSessionSplit(sessionId: string) {
    const tabId = await reveal(sessionId);
    const revealed = tabId ? session.sessionFor(tabId) : undefined;
    if (revealed) session.openSplitChat(revealed.id);
    requestInputFocus();
  }

  /** A linked row opens wherever that kind lives — the same routing the task
   *  page uses, so a doc opened from the rail lands in the same surface. */
  function openLink(link: TaskLink) {
    switch (link.kind) {
      case "work":
        void session.openWorkModal(link.targetKey, link.liveTitle || link.title, {
          secondary: true,
        });
        break;
      case "plan":
        void session.openPlanModal(`${link.targetScope}__${link.targetKey}`);
        break;
      case "automation":
        session.openAutomationBuilder(link.targetKey);
        break;
      case "pr": {
        const number = Number(link.targetKey);
        if (Number.isFinite(number)) {
          const target = linkedPrNavigationTarget({
            taskServerId: store.hostFor(task.id),
            taskProjectDirectory: projectCwd ?? task.projectKey,
            linkProjectDirectory: link.targetScope,
          });
          void session.enterPrReview(number, link.title, {
            ctx: target.projectDirectory
              ? session.ctxForDirectory(target.projectDirectory)
              : session.ctx,
            serverId: target.serverId,
          });
        }
        break;
      }
    }
    requestInputFocus();
  }

  function newSession() {
    void session
      .openTaskSession(task)
      .catch((err) =>
        toasts.error("Couldn't start a session", {
          description: err instanceof Error ? err.message : String(err),
        }),
      );
  }

</script>

<!-- Two lists and nothing else: one line per session, one line per linked
object. The task's identity — its ref, opened date and actions — is all in
the section header, and there is no footer, so the body never reports
anything the header already says.

Every row here is the rail's row, not the mock's: full width of the card's
inner edge with 8px of its own padding, exactly like MenuRow in Environment
and Git. That 8px is the card's text measure, so the group labels and every
row label set on the same left edge. -->
<div class="mb-2 flex flex-col text-xs {task.status === 'done' ? 'opacity-[.62]' : ''}">
  <div class="mt-0.5 flex flex-col gap-px">
    <!-- Six attempts stay visible at once. Older attempts scroll inside this
         group so a long history cannot take over the project rail; New session
         stays pinned below the history. -->
    <div class="scrollbar-on-hover max-h-48 overflow-y-auto overscroll-contain">
      {#each sessionRows as row (row.sessionId)}
        {@const StatusIcon = row.icon}
        <!-- State is the leading glyph and nothing else; elapsed reads at rest
        and hands its slot to the actions on hover, so the row keeps one
        value column and never changes height. -->
        <div
          class="group flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-[0.4375rem] px-2 py-[0.3125rem] text-(--solus-text-secondary) transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none {row.current
          ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
          : ''} {row.dimmed ? 'opacity-[.62] hover:opacity-100' : ''}"
          role="button"
          tabindex="0"
          title="{row.stateLabel} · {row.startedAt}"
          onclick={() => void openSession(row.sessionId)}
          onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void openSession(row.sessionId);
          }
          }}
        >
          <!-- A state tone is a fact, so it survives hover; an untinted glyph
          tracks the label like every other row in the rail. No column width:
          the 13px glyph sets its own, so a task row's label lands on the same
          left edge as a Git or Environment row. -->
          <span
            class="inline-flex shrink-0 transition-colors duration-150 {row.iconColor
            ? ''
            : 'text-(--solus-text-secondary) group-hover:text-(--solus-text-primary)'}"
            style={row.iconColor ? `color:${row.iconColor}` : undefined}
            role="img"
            aria-label={row.stateLabel}
          >
            <StatusIcon size={13} class={row.spin ? "animate-spin" : undefined} />
          </span>

          <span class="min-w-0 flex-1 truncate">{row.title}</span>

          <!-- One trailing reading in the rail's metric voice, then the secondary
          action, which trades places with it on hover so the row keeps a
          single value column and never changes width. A coarse pointer has no
          hover to trade on, so it takes the action side at rest — otherwise the
          split has no way in at all on a tablet. -->
          <span
            class="shrink-0 truncate text-(--solus-text-tertiary) group-hover:hidden pointer-coarse:hidden {row.valueMono
            ? 'tabular-nums'
            : ''}"
          >
            {row.value}
          </span>

          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  class="hidden size-6 shrink-0 cursor-pointer items-center justify-center rounded-[0.375rem] text-(--solus-text-tertiary) transition-colors duration-150 group-hover:flex pointer-coarse:flex hover:bg-[color-mix(in_srgb,var(--solus-text-primary)_8%,transparent)] hover:text-(--solus-text-primary) focus-visible:flex focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none"
                  aria-label="Open in split"
                  onclick={(e) => {
                  e.stopPropagation();
                  void openSessionSplit(row.sessionId);
                  }}
                >
                  <ColumnsIcon size={12} />
                </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value="Open in split" />
          </TooltipUI.Root>
        </div>
      {/each}
    </div>

    <button
      type="button"
      class="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-[0.4375rem] px-2 py-[0.3125rem] text-(--solus-text-secondary) transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none"
      onclick={newSession}
    >
      <PlusIcon size={13} class="shrink-0" />
      New session
    </button>
  </div>

  <!-- An empty group is dropped rather than shown at zero, so Linked only
  exists once something is attached. -->
  {#if linkList.total}
    <!-- Same hairline the Environment card draws under its branch block, so the
    two groups separate in one language across the rail. -->
    <div
      class="mx-2 mt-2 mb-1.5 h-px bg-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)]"
      aria-hidden="true"
      ></div>
      <div class="flex items-center gap-2 px-2">
        <span
          class="font-medium text-(--solus-text-tertiary) uppercase"
        >
          Linked
        </span>
        <span class="tabular-nums text-(--solus-text-tertiary) opacity-70">
          {linkList.total}
        </span>
      </div>

      <div class="mt-0.5 flex flex-col gap-px">
        {#each linkList.rows as row (row.key)}
          {@const KindIcon = row.icon}
          <button
            type="button"
            class="group flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-[0.4375rem] px-2 py-[0.3125rem] text-(--solus-text-secondary) transition-[background-color,color,opacity] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none {row.dimmed
            ? 'opacity-[.62] hover:opacity-100'
            : ''}"
            title="{row.kindLabel} · {row.label}"
            onclick={() => openLink(row.link)}
          >
            <!-- Type is carried by the glyph, not by a heading, so the list stays
            flat and sorts by recency. In Linked the glyph stays muted: the
            same column carries state only in Sessions. -->
            <span
              class="inline-flex shrink-0 text-(--solus-text-secondary) transition-colors duration-150 group-hover:text-(--solus-text-primary)"
              aria-hidden="true"
            >
              <KindIcon size={13} />
            </span>
            {#if row.ref}
              <span
                class="shrink-0 text-(--solus-text-tertiary)"
              >
                {row.ref}
              </span>
            {/if}
            <span class="min-w-0 flex-1 truncate text-left">{row.label}</span>
            {#if row.value}
              <span
                class="shrink-0 text-(--solus-text-tertiary) {row.valueMono
                ? 'tabular-nums'
                : ''}"
              >
                {row.value}
              </span>
            {/if}
          </button>
        {/each}

        {#if linkList.moreLabel}
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-1 rounded-[0.4375rem] px-2 py-1.5 text-(--solus-text-tertiary) transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none"
            onclick={() => (expanded = true)}
          >
            <span class="flex-1 text-left">{linkList.moreLabel}</span>
            <CaretDownIcon size={11} class="shrink-0 opacity-60" />
          </button>
        {/if}
      </div>
    {/if}
  </div>
