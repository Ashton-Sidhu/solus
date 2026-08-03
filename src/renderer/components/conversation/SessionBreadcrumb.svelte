<script lang="ts">
  import {
    DotsThreeIcon,
    FolderOpenIcon,
    PlusIcon,
    SidebarSimpleIcon,
    SpinnerGapIcon,
    XIcon,
  } from "phosphor-svelte";
  import { getWorkspaceContext, getSessionSidebarStore } from "../../contexts";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import { frameChrome } from "../layout/frame-chrome.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { getAttentionIcon } from "../../lib/sessionUtils";
  import * as Breadcrumb from "../ui/breadcrumb";
  import ProjectMark from "../session/ProjectMark.svelte";
  import {
    projectInitial,
    taskStatusFor,
    type SidebarTask,
  } from "../session/lib/task-list";
  import {
    projectNote,
    statusColor,
    statusNote,
  } from "./lib/session-breadcrumb";

  interface Props {
    /** The session on screen — the last crumb. */
    tabId: string;
    /** Opens the same menu the sidebar's ⋯ opens, anchored under the button. */
    onSessionMenu: (tabId: string, anchor: HTMLElement) => void;
    /** A fresh session does not need an action that creates another one. */
    showNewSessionAction?: boolean;
  }
  let {
    tabId,
    onSessionMenu,
    showNewSessionAction = true,
  }: Props = $props();

  const session = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();

  const task = $derived(sidebarStore.activeTask);
  const sessions = $derived(sidebarStore.activeTaskSessions);
  const current = $derived(sessions.find((child) => child.tabId === tabId));
  const currentStatus = $derived(taskStatusFor(current?.attention ?? null));
  const statusIcon = $derived(getAttentionIcon(current?.attention ?? null));
  const currentStatusColor = $derived(statusColor(currentStatus));
  // Null while the session runs on this machine — the default the band never
  // needs to spell out.
  const hostAffinity = $derived(
    serversStore.affinityFor(session.sessionFor(tabId)?.serverId),
  );
  const hostLabel = $derived(
    serversStore.hostFor(session.sessionFor(tabId)?.serverId)?.label ?? "",
  );

  // The project crumb is a click, not a hover: it is the one move that changes
  // everything under it, so it must not happen on the way past.
  let menu = $state<"project" | "task" | "session" | null>(null);
  let sessionMenuAnchor = $state<HTMLElement | null>(null);

  function selectTask(next: SidebarTask) {
    menu = null;
    sidebarStore.selectBranch(next.key, next.tabIds);
    requestInputFocus();
  }

  function selectSession(nextTabId: string) {
    menu = null;
    sidebarStore.selectTab(nextTabId);
    requestInputFocus();
  }

  /** Closing the row you are standing on moves you elsewhere, so the menu that
   *  described the old location has to go with it. Closing any other row leaves
   *  the menu open — you came here to tidy up, and one close is rarely one. */
  function closeTask(item: SidebarTask) {
    if (item.key === task?.key) menu = null;
    sidebarStore.closeTask(item);
    requestInputFocus();
  }

  function closeSession(childTabId: string) {
    if (childTabId === tabId) menu = null;
    sidebarStore.closeTabs([childTabId]);
    requestInputFocus();
  }

  /** Choosing a project lands on its most urgent task and filters the list to
   *  match, so the sidebar and the breadcrumb never disagree. */
  function pickProject(projectKey: string, leadTaskKey: string) {
    menu = null;
    sidebarStore.setProjectFilter(projectKey);
    const lead = sidebarStore.allTasks.find((item) => item.key === leadTaskKey);
    if (lead) sidebarStore.selectBranch(lead.key, lead.tabIds);
    requestInputFocus();
  }

  async function newSession() {
    menu = null;
    await session.createTab();
    requestInputFocus();
  }

  const crumbButton =
    "flex h-[1.875rem] cursor-pointer items-center rounded px-[0.46875rem] transition-[background] duration-150 hover:bg-accent";
  const menuRow =
    "flex h-[2.125rem] w-full cursor-pointer items-center gap-[0.5625rem] rounded-md px-[0.5625rem] text-left transition-[background] duration-150 hover:bg-accent";
  const menuLabel =
    "min-w-0 flex-1 overflow-hidden text-[0.8125rem] text-ellipsis whitespace-nowrap";
  const menuHeading =
    "px-[0.5625rem] pt-1.5 pb-1.5 text-[0.5625rem] font-semibold tracking-[0.09em] text-muted-foreground uppercase";
  // Rows you can close reserve the slot the X lands in, so nothing reflows the
  // moment a pointer crosses the row.
  // The wash follows the row, not the pointer's exact target: reaching for the X
  // must not read as leaving the row.
  const menuRowClosable = `${menuRow} pr-7 group-hover/row:bg-accent`;
  const rowStatus = "shrink-0 text-[0.65625rem] font-medium whitespace-nowrap";
  const rowClose =
    "absolute top-1/2 right-[0.4375rem] flex size-[1.125rem] -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-[opacity,background,color] duration-150 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100";
  const bandAction =
    "flex size-[1.875rem] shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-[background,color] duration-150 hover:bg-accent hover:text-foreground";
</script>

{#if task}
  <!-- Scrim: the transcript dissolves into the background under the band rather
       than being clipped by a hard edge. -->
  <div
    class="pointer-events-none absolute inset-x-0 top-0 z-[2] h-24"
    style="background:linear-gradient(to bottom, var(--background) 56%, transparent)"
    aria-hidden="true"
  ></div>

  <!-- One band across the top of the window: traffic lights and the panel toggle
       on the left (owned by the frame), the crumb continuing across it. On the
       mac editor its height matches the native titlebar band so both rows share
       a centreline. The crumb has no container of its own — it is plain text on
       the band, and the only affordance is the hover wash under each part. -->
  <div
    class="crumb-band absolute inset-x-0 top-0 z-[3] flex h-[2.875rem] items-center gap-px pr-3.5 text-[0.84375rem]"
    style="padding-left:{frameChrome.sidebarOpen
      ? '1.125rem'
      : 'max(1.125rem, calc(var(--solus-chrome-lead-inset, 0px) + 1.875rem))'}"
  >
    <Breadcrumb.Root aria-label="Location" class="flex min-w-0 shrink items-center">
      <!-- The band, not the list, owns the type scale and the neutral colour:
           each crumb states its own, and the leaf stays full-contrast. -->
      <Breadcrumb.List
        class="min-w-0 flex-nowrap gap-px text-[0.84375rem] text-foreground"
      >
        <Breadcrumb.Item class="relative shrink-0" onmouseleave={() => (menu = null)}>
          <Breadcrumb.Link class="{crumbButton} gap-[0.4375rem] pl-[0.3125rem]">
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                title="Switch project"
                aria-expanded={menu === "project"}
                onclick={() => (menu = menu === "project" ? null : "project")}
              >
                <ProjectMark
                  projectKey={task.projectKey}
                  initial={projectInitial(task.projectLabel)}
                  active
                  class="size-4"
                  letterClass="text-[0.53125rem]"
                />
                <span class="whitespace-nowrap text-muted-foreground"
                  >{task.projectLabel}</span
                >
              </button>
            {/snippet}
          </Breadcrumb.Link>
          {#if menu === "project"}
            <div class="absolute top-[1.875rem] left-0 z-[8] pt-1.5">
              <div class="menu-surface w-[18.25rem] p-[0.3125rem]">
                <div class={menuHeading}>Projects</div>
                {#each sidebarStore.projectSummaries as project (project.projectKey)}
                  {@const note = projectNote(project.waiting, project.failed)}
                  <button
                    type="button"
                    class={menuRow}
                    onclick={() =>
                      pickProject(project.projectKey, project.leadTaskKey)}
                  >
                    <ProjectMark
                      projectKey={project.projectKey}
                      initial={project.initial}
                      active={project.projectKey === task.projectKey}
                      class="size-[1.125rem]"
                      letterClass="text-[0.5625rem]"
                    />
                    <span
                      class="{menuLabel} {project.projectKey === task.projectKey
                        ? 'font-medium'
                        : ''}">{project.label}</span
                    >
                    {#if note}
                      <span
                        class="shrink-0 text-[0.65625rem] font-medium"
                        style:color={note.tone === "primary"
                          ? "var(--solus-status-permission)"
                          : "var(--solus-status-error)"}>{note.text}</span
                      >
                    {/if}
                    <span
                      class="shrink-0 font-mono text-[0.625rem] text-muted-foreground opacity-50 tabular-nums"
                      >{project.count}</span
                    >
                  </button>
                {/each}
                <div
                  class="mx-[0.5625rem] my-[0.3125rem] h-px bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
                ></div>
                <button
                  type="button"
                  class="{menuRow} h-8 text-muted-foreground hover:text-foreground"
                  onclick={() => {
                    menu = null;
                    window.dispatchEvent(
                      new CustomEvent("solus:open-project", { detail: { tabId } }),
                    );
                  }}
                >
                  <FolderOpenIcon size={15} class="shrink-0" />
                  <span class="flex-1 text-[0.8125rem]">Open project…</span>
                </button>
              </div>
            </div>
          {/if}
        </Breadcrumb.Item>

        <Breadcrumb.Separator
          class="shrink-0 px-[0.1875rem] text-muted-foreground opacity-30">/</Breadcrumb.Separator
        >

        <!-- Hover to switch: a crumb is a menu. The menu stays open while the
             pointer is inside it, so switching is hover, read, click. -->
        <Breadcrumb.Item
          class="relative min-w-0 shrink"
          onmouseenter={() => (menu = "task")}
          onmouseleave={() => (menu = null)}
        >
          <!-- Hover opens it, but the click and the focus have to as well: a menu
               that only exists under a pointer is not reachable from the keyboard. -->
          <Breadcrumb.Link class="{crumbButton} max-w-full">
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                aria-expanded={menu === "task"}
                onclick={() => (menu = menu === "task" ? null : "task")}
                onfocus={() => (menu = "task")}
              >
                <span
                  class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground"
                  >{task.title}</span
                >
              </button>
            {/snippet}
          </Breadcrumb.Link>
          {#if menu === "task"}
            <div class="absolute top-[1.875rem] left-0 z-[8] pt-1.5">
              <div class="menu-surface w-[19.75rem] p-[0.3125rem]">
                <div class={menuHeading}>Tasks in {task.projectLabel}</div>
                {#each sidebarStore.tasksInActiveProject as item (item.key)}
                  {@const note = statusNote(item.status)}
                  <div class="group/row relative">
                    <button
                      type="button"
                      class={menuRowClosable}
                      onclick={() => selectTask(item)}
                    >
                      <span
                        class="{menuLabel} {item.key === task.key
                          ? 'font-medium'
                          : ''}">{item.title}</span
                      >
                      {#if item.status === "running"}
                        <span
                          class={rowStatus}
                          role="img"
                          aria-label="Running"
                          title="Running"
                        >
                          <SpinnerGapIcon
                            size={13}
                            class="animate-spin motion-reduce:animate-none"
                          />
                        </span>
                      {:else if note}
                        <span class={rowStatus} style:color={note.color}
                          >{note.text}</span
                        >
                      {/if}
                    </button>
                    <button
                      type="button"
                      class={rowClose}
                      title="Close task"
                      aria-label="Close {item.title}"
                      onclick={() => closeTask(item)}
                    >
                      <XIcon size={11} weight="bold" />
                    </button>
                  </div>
                {/each}
                <div
                  class="mx-[0.5625rem] my-[0.3125rem] h-px bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
                ></div>
                <button
                  type="button"
                  class="{menuRow} h-8 text-muted-foreground hover:text-foreground"
                  onclick={() => {
                    menu = null;
                    void session.createTab();
                    requestInputFocus();
                  }}
                >
                  <PlusIcon size={14} class="shrink-0" />
                  <span class="flex-1 text-[0.8125rem]">New task</span>
                  <span class="font-mono text-[0.65625rem] opacity-60"
                    >{comboHint("global.new-tab")}</span
                  >
                </button>
              </div>
            </div>
          {/if}
        </Breadcrumb.Item>

        <Breadcrumb.Separator
          class="shrink-0 px-[0.1875rem] text-muted-foreground opacity-30">/</Breadcrumb.Separator
        >

        <Breadcrumb.Item
          class="relative min-w-0 shrink"
          onmouseenter={() => (menu = "session")}
          onmouseleave={() => (menu = null)}
        >
          <Breadcrumb.Link class="{crumbButton} max-w-full gap-[0.4375rem]">
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                aria-expanded={menu === "session"}
                onclick={() => (menu = menu === "session" ? null : "session")}
                onfocus={() => (menu = "session")}
              >
                <span
                  class="min-w-0 overflow-hidden font-medium tracking-[-0.005em] text-ellipsis whitespace-nowrap"
                  >{current?.label ?? "Session"}</span
                >
                {#if statusIcon}
                  {@const StatusIcon = statusIcon.component}
                  <span
                    class="flex size-[0.8125rem] shrink-0 items-center justify-center {statusIcon.spin
                      ? 'animate-spin motion-reduce:animate-none'
                      : ''}"
                    style:color={currentStatusColor ?? statusIcon.color}
                    role="img"
                    aria-label={statusNote(currentStatus)?.text}
                    title={statusNote(currentStatus)?.text}
                  >
                    <StatusIcon size={13} weight="regular" />
                  </span>
                {/if}
              </button>
            {/snippet}
          </Breadcrumb.Link>
          {#if menu === "session"}
            <div class="absolute top-[1.875rem] left-0 z-[8] pt-1.5">
              <div class="menu-surface w-[18rem] p-[0.3125rem]">
                <div class={menuHeading}>Sessions</div>
                {#each sessions as child (child.tabId)}
                  {@const status = taskStatusFor(child.attention)}
                  {@const note = statusNote(status)}
                  <div class="group/row relative">
                    <button
                      type="button"
                      class={menuRowClosable}
                      onclick={() => selectSession(child.tabId)}
                    >
                      <span
                        class="{menuLabel} {child.tabId === tabId
                          ? 'font-medium'
                          : ''}">{child.label}</span
                      >
                      {#if status === "running"}
                        <span
                          class={rowStatus}
                          role="img"
                          aria-label="Running"
                          title="Running"
                        >
                          <SpinnerGapIcon
                            size={13}
                            class="animate-spin motion-reduce:animate-none"
                          />
                        </span>
                      {:else if note}
                        <span class={rowStatus} style:color={note.color}
                          >{note.text}</span
                        >
                      {/if}
                    </button>
                    <button
                      type="button"
                      class={rowClose}
                      title="Close session"
                      aria-label="Close {child.label}"
                      onclick={() => closeSession(child.tabId)}
                    >
                      <XIcon size={11} weight="bold" />
                    </button>
                  </div>
                {/each}
                <div
                  class="mx-[0.5625rem] my-[0.3125rem] h-px bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
                ></div>
                <button
                  type="button"
                  class="{menuRow} h-8 text-muted-foreground hover:text-foreground"
                  onclick={newSession}
                >
                  <PlusIcon size={14} class="shrink-0" />
                  <span class="flex-1 text-[0.8125rem]"
                    >New session in this task</span
                  >
                </button>
              </div>
            </div>
          {/if}
        </Breadcrumb.Item>
      </Breadcrumb.List>
    </Breadcrumb.Root>

    <span class="min-w-4 flex-1"></span>

    <!-- Where this session runs — the one fact about it the crumb's own path
         cannot state, and the reason the old capsule carried a host chip. -->
    {#if hostAffinity}
      {@const HostIcon = hostAffinity.icon}
      <span
        class="mr-2 flex shrink-0 items-center gap-1.5 {hostAffinity.className}"
        title={hostAffinity.tooltip}
      >
        <HostIcon size={12} />
        <span class="font-mono text-[0.65625rem] whitespace-nowrap">{hostLabel}</span>
      </span>
    {/if}

    {#if showNewSessionAction}
      <button
        type="button"
        class="flex h-[1.875rem] shrink-0 cursor-pointer items-center gap-1.5 rounded pr-2.5 pl-2 transition-[background] duration-150 hover:bg-accent"
        style="box-shadow:0 0 0 0.03125rem color-mix(in oklch, var(--foreground) 12%, transparent)"
        title="New session in this task"
        onclick={newSession}
      >
        <PlusIcon size={13} class="text-muted-foreground" />
        <span class="text-[0.8125rem] font-medium whitespace-nowrap">New session</span>
      </button>
    {/if}

    <button
      type="button"
      class="{bandAction} ml-0.5"
      bind:this={sessionMenuAnchor}
      title="Session menu"
      aria-label="Session menu"
      onclick={() => sessionMenuAnchor && onSessionMenu(tabId, sessionMenuAnchor)}
    >
      <DotsThreeIcon size={14} weight="bold" />
    </button>

    <button
      type="button"
      class={bandAction}
      title={frameChrome.projectPanelOpen
        ? "Collapse project panel"
        : "Expand project panel"}
      aria-label={frameChrome.projectPanelOpen
        ? "Collapse project panel"
        : "Expand project panel"}
      onclick={() => {
        frameChrome.toggleProjectPanelFromFrame?.();
        requestInputFocus();
      }}
    >
      <SidebarSimpleIcon size={13} mirrored />
    </button>
  </div>
{/if}

<style>
  .crumb-band {
    animation: crumb-enter 0.18s ease-out;
  }

  :global(html.is-mac-editor) .crumb-band {
    height: var(--solus-titlebar-height);
  }

  @keyframes crumb-enter {
    from {
      opacity: 0;
      transform: translateY(-0.25rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .crumb-band {
      animation: none;
    }
  }
</style>
