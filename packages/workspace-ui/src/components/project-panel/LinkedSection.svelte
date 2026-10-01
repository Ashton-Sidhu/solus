<script lang="ts">
  import { untrack } from "svelte";
  import { GitPullRequest as GitPullRequestIcon } from "@lucide/svelte";
  import type { SessionPullRequestLink } from "@solus/contracts/session-pull-requests";
  import { serverConnections } from "@solus/client-core/server-connections";
  import {
    getPullRequestsContext,
    getSessionEnvironmentStore,
    getWorkspaceContext,
  } from "../../contexts";
  import {
    sessionPrLink,
    sessionPullRequestsStore,
  } from "../../contexts/prs/session-pull-requests.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { copyText, toasts } from "../../lib/toasts";
  import * as TooltipUI from "../ui/tooltip";
  import LinkedArtifactContextMenu from "./LinkedArtifactContextMenu.svelte";
  import { linkedPullRequestRows, pullRequestOpenTarget } from "./lib/linked-pull-requests";

  interface Props {
    /** The tab whose session owns these links. */
    sourceId: string;
    /** The session's links, newest first. */
    links: SessionPullRequestLink[];
    /** False while this mounted tab's project rail is not on screen. */
    active: boolean;
  }
  let { sourceId, links, active }: Props = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const environmentStore = getSessionEnvironmentStore();
  const prs = pullRequests.projects;

  const env = $derived(environmentStore.environmentFor(session.runFor(sourceId)));
  const serverId = $derived(session.serverIdFor(sourceId));
  const rows = $derived(
    linkedPullRequestRows(links, (link) => prs.linkedPr(serverId, sessionPrLink(link), env.cwd)),
  );

  // PR sync on the host keeps each linked pull request fresh while the rail
  // shows it. A rail that is not on screen asks for nothing.
  $effect(() => {
    const id = serverId;
    const cwd = env.cwd;
    const prLinks = links.map(sessionPrLink);
    if (!active || !id || !prLinks.length) return;
    return untrack(() =>
      prs.wantLinkedPrs(serverConnections.apiFor(id), id, session.ctxForDirectory(cwd || "~"), prLinks),
    );
  });

  function open(link: SessionPullRequestLink) {
    void session.prReview.openPullRequest(
      pullRequestOpenTarget(link),
      {
        ctx: session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
        serverId: serverId ?? undefined,
        target: "aside",
      },
    );
    requestInputFocus();
  }

  async function copyReference(link: SessionPullRequestLink) {
    await copyText(link.url);
    toasts.success("Reference copied");
    requestInputFocus();
  }

  function unlink(link: SessionPullRequestLink) {
    if (serverId) {
      void sessionPullRequestsStore.unlink(serverId, link).catch((error) =>
        toasts.error("Couldn't unlink this pull request", {
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    requestInputFocus();
  }

  let menu = $state<{ link: SessionPullRequestLink; x: number; y: number } | null>(null);

  function openMenu(event: MouseEvent, link: SessionPullRequestLink) {
    event.preventDefault();
    event.stopPropagation();
    menu = { link, x: event.clientX, y: event.clientY };
  }

  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressNextClick = false;
  function startLongPress(event: PointerEvent, link: SessionPullRequestLink) {
    if (event.pointerType !== "touch") return;
    longPressTimer = setTimeout(() => {
      suppressNextClick = true;
      openMenu(event, link);
    }, 500);
  }
  function cancelLongPress() {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  }
</script>

<!-- One line per linked pull request. The list is bounded so a long stack
does not push the rest of the rail off screen. -->
<div class="scrollbar-on-hover mb-2 flex max-h-32 flex-col gap-px overflow-y-auto overscroll-contain">
  {#each rows as row (row.key)}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="group flex min-h-8 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-[0.4375rem] px-2 py-[0.3125rem] text-(--solus-text-secondary) transition-[background-color,color,opacity] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none {row.isSettled
              ? 'opacity-[.62] hover:opacity-100'
              : ''}"
            aria-label={row.detailLabel}
            onclick={() => {
              if (suppressNextClick) {
                suppressNextClick = false;
                return;
              }
              open(row.link);
            }}
            oncontextmenu={(event) => openMenu(event, row.link)}
            onpointerdown={(event) => startLongPress(event, row.link)}
            onpointerup={cancelLongPress}
            onpointercancel={cancelLongPress}
            onpointermove={cancelLongPress}
            onkeydown={(event) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu(
                  new MouseEvent("contextmenu", { clientX: rect.left + 8, clientY: rect.bottom }),
                  row.link,
                );
              }
            }}
          >
            <span
              class="inline-flex shrink-0 text-(--solus-text-secondary) transition-colors duration-150 group-hover:text-(--solus-text-primary)"
              aria-hidden="true"
            >
              <GitPullRequestIcon size={16} />
            </span>
            <span class="shrink-0 text-xs text-(--solus-text-tertiary)">#{row.number}</span>
            <span class="min-w-0 flex-1 truncate text-left font-medium">{row.title}</span>
            {#if row.state}
              <span class="shrink-0 text-xs text-(--solus-text-tertiary)">{row.state}</span>
            {/if}
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={row.detailLabel} />
    </TooltipUI.Root>
  {/each}
</div>

{#if menu}
  {@const current = menu}
  <LinkedArtifactContextMenu
    x={current.x}
    y={current.y}
    onOpen={() => open(current.link)}
    onCopyReference={() => void copyReference(current.link)}
    onUnlink={() => unlink(current.link)}
    onClose={() => (menu = null)}
  />
{/if}
