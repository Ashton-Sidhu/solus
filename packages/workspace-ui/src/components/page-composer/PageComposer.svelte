<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { prefersReducedMotion } from "svelte/motion";
  import { scale } from "svelte/transition";
  import { MessageCircle as ChatCircleIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import type { SessionDraft } from "../../contexts/workspace/session-draft.svelte";
  import type { CreateTabOptions } from "../../contexts/workspace/workspace.context.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { cn } from "../../lib/utils";
  import { Button } from "../ui/button";
  import type { PaneSurfaceProps } from "../ui/lib/pane-surface";
  import DraftComposer from "../session-draft/DraftComposer.svelte";

  /**
   * A page's way to start an agent on it: one chat glyph docked at the foot of
   * the page, which opens into the same composer a new session gets. Send turns
   * the draft into a session and pops its conversation out beside the page.
   */
  interface Props extends Pick<PaneSurfaceProps, "onAttachFile" | "onScreenshot" | "onDesignMode"> {
    /** The pane the page fills. Its composer is this one. */
    paneId: string;
    /** What the draft is aimed at: the work it binds, the host it runs on. */
    aim: CreateTabOptions;
    /** The project the draft starts in, when the page has one. */
    cwd?: string;
    /** How the started session gets its first prompt when the page has work to
     *  finish first — a pull request's checkout, shown in the conversation as
     *  it runs. Without it the prompt is sent at once. */
    sendFirstPrompt?: (tabId: string, text: string) => void;
    /** The page decides where the session runs — a work's own project, a pull
     *  request's worktree — so the composer offers no project or host. */
    destinationFixed?: boolean;
    label?: string;
    /** Where the folded glyph docks, when the page has its own bar at its
     *  foot for the glyph to line up with. */
    class?: string;
  }
  let {
    paneId,
    aim,
    cwd,
    sendFirstPrompt,
    destinationFixed = false,
    label = "Work with this page",
    class: glyphClass,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: Props = $props();

  const session = getWorkspaceContext();

  // The draft the page holds: the one the next Send starts, or null once it has.
  let draft = $state.raw<SessionDraft | null>(null);
  // The draft on screen. Send and fold let go of `draft` while the bar is still
  // clearing the text it sent and the composer is still scaling away, and
  // both read the draft they were given until they are gone — so the rendered
  // one is held apart, the way the draft pane holds its `sent` draft.
  let shown = $state.raw<SessionDraft | null>(null);
  let expanded = $state(false);
  let composerEl = $state<HTMLDivElement | null>(null);
  let composerInput = $state<ReturnType<typeof DraftComposer> | null>(null);
  // Folded with words still in it, the glyph says so.
  const hasUnsent = $derived(!!draft && !draft.isEmpty);

  async function expand() {
    draft ??= session.drafts.openDockedDraft({ ...aim, via: "click" }, cwd);
    shown = draft;
    expanded = true;
    // The caret waits for the pop-out: one placed mid-scale is painted at the
    // scaled size and can stay a filled block. Without the motion there is no
    // scale to wait for.
    if (!prefersReducedMotion.current) return;
    await tick();
    composerInput?.focus();
  }

  function fold() {
    expanded = false;
    if (draft?.isEmpty) {
      session.drafts.undockDraft(draft.id);
      draft = null;
    }
  }

  // A written-in draft outlives the page: the sidebar lists it.
  onDestroy(() => {
    if (draft) session.drafts.undockDraft(draft.id);
  });

  /** The draft becomes a session, and its conversation opens beside the page. */
  function start(current: SessionDraft, text: string): string | null {
    const besidePage = session.hasCompanionPanes;
    const tabId = session.drafts.startSessionDraft(current.id, { via: "click", activate: !besidePage });
    if (!tabId) return null;
    draft = null;
    const started = session.sessionFor(tabId);
    if (besidePage) {
      if (started) session.openChatSurface(started.id);
      requestInputFocus({ tabId });
    } else {
      session.router.closePane(paneId);
    }
    if (sendFirstPrompt) {
      sendFirstPrompt(tabId, text);
      return tabId;
    }
    return session.dispatch.sendMessage(text, undefined, tabId) ? tabId : null;
  }

  function dispatch(text: string): boolean {
    const current = draft;
    return !!current && start(current, text) !== null;
  }

  // A click on the page itself folds an empty composer back to its glyph.
  // Menus portal out of the page, so a pick from one never reads as leaving.
  $effect(() => {
    const host = expanded ? composerEl?.parentElement : null;
    if (!host) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || !host.contains(target) || composerEl?.contains(target)) return;
      if (draft?.isEmpty) fold();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  });
</script>

{#if expanded && shown}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={composerEl}
    class="absolute right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom,0px))] z-30 w-[min(44rem,calc(100%-1.5rem))] origin-bottom-right"
    data-testid="page-composer"
    in:scale={{ start: 0.08, opacity: 0, duration: prefersReducedMotion.current ? 0 : 200, easing: cubicOut }}
    out:scale={{ start: 0.08, opacity: 0, duration: prefersReducedMotion.current ? 0 : 140, easing: cubicOut }}
    onintroend={() => composerInput?.focus()}
    onkeydown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.stopPropagation();
        fold();
      }
    }}
  >
    <DraftComposer
      bind:this={composerInput}
      draft={shown}
      {paneId}
      active
      isPrimary={false}
      floating
      {destinationFixed}
      maxHeight={200}
      idlePlaceholder={`${label}…`}
      onDispatch={dispatch}
      onSent={() => (expanded = false)}
      {onAttachFile}
      {onScreenshot}
      {onDesignMode}
    />
  </div>
{:else}
  <div
    class={cn("absolute right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom,0px))] z-30", glyphClass)}
    in:scale={{ start: 0.6, opacity: 0, duration: prefersReducedMotion.current ? 0 : 140, delay: prefersReducedMotion.current ? 0 : 100, easing: cubicOut }}
  >
    <Button
      variant="outline"
      size="icon-lg"
      class={cn(
        "relative size-10 rounded-full shadow-[shadow:0_4px_16px_color-mix(in_oklch,var(--foreground)_10%,transparent)] pointer-coarse:size-12",
        hasUnsent && "after:absolute after:top-1.5 after:right-1.5 after:size-2 after:rounded-full after:bg-(--solus-accent)",
      )}
      data-testid="open-page-composer"
      title={hasUnsent ? `${label} — unsent message` : label}
      aria-label={label}
      onclick={() => void expand()}
    >
      <ChatCircleIcon size={18} strokeWidth={1.5} />
    </Button>
  </div>
{/if}
