<script lang="ts">
  import type { Task, TaskLink } from "@solus/contracts/task-types";
  import { getPullRequestsContext, getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { copyText, toasts } from "../../lib/toasts";
  import { serverConnections } from "@solus/client-core/server-connections";
  import * as TooltipUI from "../ui/tooltip";
  import { railLinkList } from "./lib/rail-task-card";
  import { linkedPrNavigationTarget } from "../tasks/task-page/lib/linked-pr-navigation";
  import LinkedArtifactContextMenu from "./LinkedArtifactContextMenu.svelte";

  interface Props {
    /** The task the rail's session is working. */
    task: Task;
    /** Project the task belongs to — GitHub detail reads are routed by it. */
    projectCwd?: string;
    /** False while this mounted tab's project rail is not on screen. */
    active?: boolean;
  }
  let { task, projectCwd, active = true }: Props = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const store = session.tasksStore;

  // Links live on the task's detail record. The rail owns that read: the card
  // only exists once a link is on it, so the fetch cannot live in the card it
  // decides the existence of.
  const links = $derived(store.get(task.id).details?.links ?? []);

  // A PR link snapshots only its number and a link-time title, which is often
  // no more than "#65" — the same reference the row already prints in its own
  // column. The real title is a provider read the host keeps off the task read,
  // so the rail overlays it from the shared store the task page and the picker
  // also read. Until that lands the row still renders from its snapshot.
  const prs = pullRequests.projects;
  const prScope = $derived({
    serverId: store.get(task.id).serverId,
    projectDirectory: projectCwd ?? task.projectKey,
  });
  function prTitleFor(link: TaskLink): string | undefined {
    const target = linkedPrNavigationTarget({
      taskServerId: prScope.serverId,
      taskProjectDirectory: prScope.projectDirectory,
      linkProjectDirectory: link.targetScope,
    });
    // The target scope is one repository, so the number alone identifies the
    // pull request — no base-repo comparison needed.
    return prs.at(target.serverId, target.projectDirectory)?.prFor(
      Number(link.targetKey),
    )?.title || undefined;
  }

  const linkList = $derived(
    railLinkList(
      links,
      (id) => session.automationsStore.get(id),
      Date.now(),
      prTitleFor,
    ),
  );

  // The store asks each project's list once and each unknown PR at most once,
  // so this is safe on every render — but a rail that is not on screen has
  // nothing to name, and must not spend a host round trip saying so.
  $effect(() => {
    const { serverId, projectDirectory } = prScope;
    const numbers = links
      .filter((link) => link.kind === "pr")
      .map((link) => Number(link.targetKey))
      .filter((number) => Number.isSafeInteger(number));
    if (!active || !serverId || !projectDirectory || !numbers.length) return;
    prs
      .get(
        serverConnections.apiFor(serverId),
        serverId,
        session.ctxForDirectory(projectDirectory),
      )
      .ensureNumbers(numbers);
  });

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
            taskServerId: store.get(task.id).serverId,
            taskProjectDirectory: projectCwd ?? task.projectKey,
            linkProjectDirectory: link.targetScope,
          });
          void session.openPullRequest({
            number,
            title: link.title,
            url: link.url,
          }, {
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

  async function copyLinkReference(link: TaskLink) {
    const reference = link.url || link.targetKey;
    await copyText(reference);
    toasts.success("Reference copied");
    requestInputFocus();
  }

  function unlink(link: TaskLink) {
    void store
      .get(task.id)
      .unlink(link.kind, link.targetKey, link.targetScope)
      .catch((error) =>
        toasts.error("Couldn't unlink this item", {
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    requestInputFocus();
  }

  let linkMenu = $state<{ link: TaskLink; x: number; y: number } | null>(null);

  function openLinkMenu(event: MouseEvent | PointerEvent, link: TaskLink) {
    event.preventDefault();
    event.stopPropagation();
    linkMenu = { link, x: event.clientX, y: event.clientY };
  }

  let linkLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressNextLinkClick = false;
  function startLinkLongPress(event: PointerEvent, link: TaskLink) {
    if (event.pointerType !== "touch") return;
    linkLongPressTimer = setTimeout(() => {
      suppressNextLinkClick = true;
      openLinkMenu(event, link);
    }, 500);
  }
  function cancelLinkLongPress() {
    if (linkLongPressTimer) clearTimeout(linkLongPressTimer);
    linkLongPressTimer = null;
  }

</script>

<!-- One list and nothing else: a line per linked object. The task's identity —
its ref, opened date and actions — is all in the section header. An empty body
is dropped rather than shown at zero, so the card has a body only once
something is attached; sessions are read in the sidebar and on the task page,
and the rail does not repeat them.

Every row here is the rail's row, not the mock's: full width of the card's
inner edge with 8px of its own padding, exactly like MenuRow in Environment
and Git.

Type comes from the rail, which declares the display's chrome rung once, so a
row label here reads at the same size as a Git or Environment row. Only the
quiet trailing readings pin themselves a rung below. -->
{#if linkList.total}
  <div class="mb-2 flex flex-col {task.status === 'done' ? 'opacity-[.62]' : ''}">
    <!-- A task can collect more links than the rail has room for. Keep the
    group bounded so it does not push the rest of the project rail off
    screen; reveal the standard thumb while the pointer is over the list. -->
    <div
      class="scrollbar-on-hover flex max-h-32 flex-col gap-px overflow-y-auto overscroll-contain"
    >
        {#each linkList.rows as row (row.key)}
          {@const KindIcon = row.icon}
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  class="group flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-[0.4375rem] px-2 py-[0.3125rem] text-(--solus-text-secondary) transition-[background-color,color,opacity] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none {row.dimmed
                  ? 'opacity-[.62] hover:opacity-100'
                  : ''}"
                  aria-label={row.detailLabel}
                  onclick={() => {
                    if (suppressNextLinkClick) {
                      suppressNextLinkClick = false;
                      return;
                    }
                    openLink(row.link);
                  }}
                  oncontextmenu={(event) => openLinkMenu(event, row.link)}
                  onpointerdown={(event) => startLinkLongPress(event, row.link)}
                  onpointerup={cancelLinkLongPress}
                  onpointercancel={cancelLinkLongPress}
                  onpointermove={cancelLinkLongPress}
                  onkeydown={(event) => {
                    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                      event.preventDefault();
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      openLinkMenu(
                        new MouseEvent("contextmenu", { clientX: rect.left + 8, clientY: rect.bottom }),
                        row.link,
                      );
                    }
                  }}
                >
                  <!-- Type is carried by the glyph, not by a heading, so the
                  list stays flat. Its full name remains in the tooltip and
                  accessible label. -->
                  <span
                    class="inline-flex shrink-0 text-(--solus-text-secondary) transition-colors duration-150 group-hover:text-(--solus-text-primary)"
                    aria-hidden="true"
                  >
                    <KindIcon size={13} />
                  </span>
                  {#if row.ref}
                    <span class="shrink-0 text-xs text-(--solus-text-tertiary)">
                      {row.ref}
                    </span>
                  {/if}
                  <span class="min-w-0 flex-1 truncate text-left">{row.label}</span>
                  {#if row.value}
                    <span
                      class="shrink-0 text-xs text-(--solus-text-tertiary) {row.valueMono
                      ? 'tabular-nums'
                      : ''}"
                    >
                      {row.value}
                    </span>
                  {/if}
                </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={row.detailLabel} />
          </TooltipUI.Root>
        {/each}
    </div>
  </div>
{/if}

{#if linkMenu}
  {@const menu = linkMenu}
  <LinkedArtifactContextMenu
    x={menu.x}
    y={menu.y}
    onOpen={() => openLink(menu.link)}
    onCopyReference={() => void copyLinkReference(menu.link)}
    onUnlink={() => unlink(menu.link)}
    onClose={() => (linkMenu = null)}
  />
{/if}
