<script lang="ts">
  import {
    ArrowsClockwiseIcon,
    CaretRightIcon,
    ChatCircleDotsIcon,
    ArrowRightIcon,
  } from "phosphor-svelte";
  import type { Automation } from "../../../shared/types";
  import type { AutomationBoard } from "./lib/automation-board";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    triggerSummary,
    relativeTime,
  } from "../automations/lib/automation-format";
  import * as Popover from "../ui/popover";

  interface Props {
    board: AutomationBoard;
  }
  let { board }: Props = $props();

  const session = getWorkspaceContext();
  const store = session.automationsStore;

  let now = $state(Date.now());
  $effect(() => {
    const hasScheduled = board.rows.some((a) => a.enabled && a.nextRunAt);
    if (!hasScheduled) return;
    const t = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(t);
  });

  // 5c: a row is a disclosure, not a jump. Its menu flanks left over the
  // conversation so the section you clicked from stays readable — one shared
  // popover anchored to whichever row is open (mirrors the Git section).
  let menuOpen = $state(false);
  let openId = $state<string | null>(null);
  let openRowEl = $state<HTMLElement | null>(null);
  const openAutomation = $derived(
    board.rows.find((a) => a.id === openId) ?? null,
  );
  const openIsRunning = $derived(openAutomation?.lastRunStatus === "running");

  function toggleMenu(a: Automation, el: HTMLElement) {
    if (menuOpen && openId === a.id) {
      menuOpen = false;
      return;
    }
    openId = a.id;
    openRowEl = el.closest(".automation-row") as HTMLElement | null;
    menuOpen = true;
  }

  function close() {
    menuOpen = false;
    requestInputFocus();
  }

  function open(a: Automation) {
    close();
    session.openAutomations(a.id);
  }

  function edit(a: Automation) {
    close();
    session.openAutomationBuilder(a.id);
  }

  async function run(a: Automation) {
    close();
    await (a.lastRunStatus === "running"
      ? store.cancel(a.id)
      : store.runNow(a.id));
  }

  async function toggleEnabled(a: Automation) {
    close();
    await store.setEnabled(a.id, !a.enabled);
  }

  function viewAll() {
    session.openAutomations();
    requestInputFocus();
  }

  // One quiet right-aligned word/phrase that names the row's state — the calm
  // single-line language of the rest of the panel. Paused / Failed read as
  // status; an active schedule reads as its next fire ("in 2 hr"), falling back
  // to the cadence ("Daily", "Manual") when nothing is queued.
  function statusLabel(a: Automation): string {
    void now; // reactive dependency — re-runs when the minute tick fires
    if (!a.enabled) return "Paused";
    if (a.lastRunStatus === "failed") return "Failed";
    if (a.nextRunAt) {
      const next = relativeTime(a.nextRunAt);
      if (next) return next;
    }
    return triggerSummary(a.trigger);
  }

  function statusColor(a: Automation): string {
    if (a.lastRunStatus === "failed" && a.enabled)
      return "var(--solus-status-error)";
    return "var(--solus-text-tertiary)";
  }
</script>

{#snippet menuRow(
  label: string,
  trail: string | undefined,
  onclick: () => void,
  quiet = false,
)}
  <button
    type="button"
    class="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[0.8125rem] lg:text-[0.8125rem] font-normal hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) {quiet
      ? 'text-(--solus-text-tertiary)'
      : 'text-(--solus-text-secondary)'}"
    {onclick}
  >
    <span class="min-w-0 flex-1 truncate">{label}</span>
    {#if trail}
      <span
        class="shrink-0 text-[0.71875rem] tabular-nums text-(--solus-text-tertiary)"
      >
        {trail}
      </span>
    {/if}
  </button>
{/snippet}

<!-- The board summary ("2 running · next in 12m") lives in the section header,
     beside the title, so the card opens straight into its rows. -->
<ul class="m-0 flex list-none flex-col gap-px p-0">
  {#each board.rows as a (a.id)}
    {@const running = a.lastRunStatus === "running"}
    {@const emphasized = running || a.favorite}
    <li class="automation-row group flex items-center">
      <button
        type="button"
        class="flex min-h-[2rem] min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[0.4375rem] border-none bg-transparent px-2 py-[0.3125rem] text-left transition-colors duration-150 hover:bg-(--solus-surface-hover) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] {menuOpen &&
        openId === a.id
          ? 'bg-(--solus-surface-hover)'
          : ''}"
        aria-haspopup="menu"
        aria-expanded={menuOpen && openId === a.id}
        onclick={(e) => toggleMenu(a, e.currentTarget)}
      >
        <!-- 5c marks the row with a bare accent cycle glyph — no icon chip — and
             fades it back for anything that isn't currently scheduled. -->
        <span
          class="inline-flex shrink-0 text-(--solus-accent) transition-opacity duration-150 {a.enabled
            ? 'opacity-100'
            : 'opacity-45'}"
          class:animate-pulse={running}
          aria-hidden="true"
        >
          <ArrowsClockwiseIcon size={13} weight={emphasized ? "bold" : "regular"} />
        </span>
        <span
          class="min-w-0 flex-1 truncate text-[0.8125rem] font-normal text-(--solus-text-secondary) transition-colors duration-150 group-hover:text-(--solus-text-primary)"
        >
          {a.name}
        </span>
        {#if a.action.sessionId}
          <span
            class="inline-flex shrink-0 text-(--solus-text-tertiary)"
            title="Runs in this chat thread"
            aria-label="Runs in this chat thread"
          >
            <ChatCircleDotsIcon size={10} />
          </span>
        {/if}
        <!-- Trailing slot: one quiet status word, then the disclosure — the
             pause/resume control moved into the menu. -->
        <span
          class="max-w-28 shrink-0 truncate text-[0.6875rem] tabular-nums whitespace-nowrap"
          style:color={statusColor(a)}
        >
          {statusLabel(a)}
        </span>
        <span
          class="inline-flex shrink-0 text-(--solus-text-tertiary) opacity-55 transition-opacity duration-150 group-hover:opacity-100"
          aria-hidden="true"
        >
          <CaretRightIcon size={11} />
        </span>
      </button>
    </li>
  {/each}
</ul>

<Popover.Root bind:open={menuOpen}>
  <Popover.Content
    customAnchor={openRowEl}
    side="left"
    align="start"
    sideOffset={10}
    alignOffset={-6}
    collisionPadding={8}
    onInteractOutside={(event) => {
      // The row is its own trigger: let its click toggle the menu instead of
      // closing here and immediately reopening.
      if ((event.target as Element | null)?.closest?.(".automation-row"))
        event.preventDefault();
    }}
    class="menu-surface z-[10002] w-[264px] gap-0 rounded-lg bg-(--solus-menu-bg) p-1.5 text-menu lg:text-menu shadow-[shadow:var(--solus-menu-shadow)] ring-0"
  >
    {#if openAutomation}
      {@const a = openAutomation}
      <!-- Title block, then the cadence beneath it: 13px over 11.5px at 1.5, the
           only two-line text in the popover vocabulary. -->
      <div class="flex items-center gap-2 px-2 pt-[0.3125rem] pb-1.5">
        <span class="inline-flex shrink-0 text-(--solus-accent)" aria-hidden="true">
          <ArrowsClockwiseIcon size={12} weight="bold" />
        </span>
        <span
          class="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-(--solus-text-primary)"
        >
          {a.name}
        </span>
      </div>
      <p
        class="m-0 px-2 pb-[0.4375rem] text-[0.71875rem] leading-[1.5] text-(--solus-text-tertiary)"
      >
        {triggerSummary(a.trigger)}
      </p>
      <div
        class="mx-2 mb-[0.3125rem] h-px bg-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)]"
        aria-hidden="true"
      ></div>
      {@render menuRow(
        openIsRunning ? "Stop run" : "Run now",
        undefined,
        () => void run(a),
      )}
      {@render menuRow("Last run", relativeTime(a.lastRunAt) || "Never", () =>
        open(a),
      )}
      {@render menuRow("Edit schedule…", undefined, () => edit(a))}
      <div
        class="mx-2 my-[0.3125rem] h-px bg-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)]"
        aria-hidden="true"
      ></div>
      <!-- Enable/disable is the menu's quietest action, so it sits below the
           rule in tertiary rather than competing with Run now. -->
      {@render menuRow(
        a.enabled ? "Pause automation" : "Resume automation",
        undefined,
        () => void toggleEnabled(a),
        true,
      )}
    {/if}
  </Popover.Content>
</Popover.Root>

{#if board.rows.length === 0}
  <p class="m-0 px-2 py-1.5 text-[0.6875rem] text-(--solus-text-tertiary)">
    Nothing scheduled or running.
  </p>
{/if}

{#if board.total > board.rows.length}
  <button
    type="button"
    class="group mt-px flex w-full cursor-pointer items-center gap-1 rounded-[0.4375rem] border-none bg-transparent px-2 py-1.5 text-left text-[0.6875rem] font-normal text-(--solus-text-tertiary) transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
    onclick={viewAll}
  >
    View all {board.total}
    <ArrowRightIcon
      size={11}
      class="motion-safe:transition-transform motion-safe:duration-150 group-hover:translate-x-0.5"
    />
  </button>
{/if}
