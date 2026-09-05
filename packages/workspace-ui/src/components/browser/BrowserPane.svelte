<script lang="ts">
  import { Bot, GitBranch, Plus, X } from "@lucide/svelte";
  import type {
    BrowserAgentUse,
    BrowserAppearance,
    BrowserDiscoveredTarget,
    BrowserEvidenceOptions,
    BrowserEvidenceTarget,
    BrowserTarget,
    BrowserViewportRequest,
  } from "@solus/contracts/browser-types";
  import { browserProfilePartition } from "@solus/contracts/browser-types";
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext } from "../../contexts";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { toasts } from "../../lib/toasts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";
  import BrowserAnnotationBar from "./BrowserAnnotationBar.svelte";
  import BrowserCloseConfirm from "./BrowserCloseConfirm.svelte";
  import BrowserCommentPopup from "./BrowserCommentPopup.svelte";
  import BrowserCaptureButton from "./BrowserCaptureButton.svelte";
  import BrowserProfileChip from "./BrowserProfileChip.svelte";
  import { projectRootOf } from "./lib/profiles";
  import {
    createAnnotationAttachment,
    mergeAnnotationAttachment,
  } from "./lib/annotation-attachment";
  import { commentAnchorPosition } from "./lib/comment-anchor";
  import {
    groupPagesByBranch,
    pageLabel,
    pageStatus,
    routeLabel,
  } from "./lib/page-strip";
  import {
    shouldUseNativeBrowser,
    supportsNativeBrowser,
  } from "./lib/browser-guest";
  import { nativeSurfaces } from "./lib/native-surface-coordinator.svelte";
  import BrowserStage from "./BrowserStage.svelte";
  import BrowserToolbar from "./BrowserToolbar.svelte";
  import BrowserTargetPicker from "./BrowserTargetPicker.svelte";

  /**
   * The browser pane: one page at a time, at whatever viewport the user picked.
   *
   * It renders no page itself. The native surface lives in the app-root webview
   * layer and is positioned over the stage's placeholder, because a `<webview>`
   * cannot survive being moved or hidden with `display: none` — which is what a
   * pane does constantly.
   */

  let { params, paneId, surfaceVisible = true }: RouteSurfaceProps<"browser"> =
    $props();

  const session = getWorkspaceContext();
  const actions = paneActions(() => paneId);
  const serverId = $derived(params.serverId ?? session.fallbackServerId);

  // The route names a page when the user deep-linked one; otherwise the pane
  // follows whichever page the store last made active — including the one an
  // agent just asked for a surface for.
  const activeKey = $derived(
    params.browserPageId
      ? browserStore.keyOf(serverId, params.browserPageId)
      : browserStore.activeKey,
  );
  const entry = $derived(activeKey ? browserStore.pages.get(activeKey) : null);
  // While a drag or a typed number is in flight, the size the user is steering
  // is the one to state. The frame and the guest below still follow the
  // viewport the host confirmed, so the picture never claims a size it is not
  // actually rendering at.
  const statedViewport = $derived(
    browserStore.requestedViewport(activeKey) ?? entry?.page.viewport,
  );
  const pages = $derived(browserStore.entries);
  const pageGroups = $derived(groupPagesByBranch(pages));
  const targets = $derived(browserStore.targetsFor(serverId));

  /** The identities this page's project has, mirrored from the page's own host. */
  const projectRoot = $derived(entry ? projectRootOf(entry.page) : undefined);
  const profileSet = $derived(
    entry ? browserStore.profilesFor(entry.serverId, projectRoot) : null,
  );

  $effect(() => {
    const current = entry;
    if (!current) return;
    void browserStore
      .loadProfiles(current.serverId, projectRootOf(current.page))
      .catch(failed("Couldn't load the browser profiles"));
  });

  /**
   * How much the stage had to shrink the device to fit, 0–1.
   *
   * Only the stage can measure it, and the toolbar's size chip has to state it:
   * a picture at 62% is a picture nothing may be measured against by eye. The
   * stage reports it rather than the chip recomputing it, so the number beside
   * the dimensions and the picture they describe cannot disagree.
   */
  let stageScale = $state(0);

  // Every control here is one RPC to the host that owns the page, and the host
  // refuses what it cannot do — a surface it could not emulate, a preset it
  // could not apply. That answer belongs to the user who pressed the button, so
  // it is said here rather than reaching the console as an unhandled rejection.
  function failed(action: string): (error: Error) => void {
    return (error) => void toasts.error(action, { description: error.message });
  }

  $effect(() => {
    const host = serverId;
    void browserStore.loadPages(host).catch(failed("Couldn't load browser pages"));
    void browserStore
      .loadTargets(host)
      .catch(failed("Couldn't scan for dev servers"));
  });

  /**
   * Warm every local native page while the Browser pane is in use.
   *
   * A page first driven by an agent lives in a headless guest. Waiting for its
   * chip to be selected before mounting the corresponding `<webview>` makes that
   * selection pay for guest creation, emulation, and a full navigation. Parked
   * guests paint offscreen, so preparing them here turns later page selection
   * into a rectangle swap without keeping a hidden pane active.
   */
  $effect(() => {
    if (!surfaceVisible) return;
    const canHostNatively = supportsNativeBrowser();
    const localServerId = serverConnections.localServerId();
    for (const candidate of pages) {
      if (
        shouldUseNativeBrowser(
          canHostNatively,
          candidate.serverId,
          localServerId,
          candidate.page.target.kind,
        )
      ) {
        nativeSurfaces.mount(
          browserStore.keyOf(
            candidate.serverId,
            candidate.page.browserPageId,
          ),
        );
      }
    }
  });

  /** True while the picker is showing over an open page — ephemeral, and only
   *  this pane's business. */
  let choosingTarget = $state(false);
  /** Keep the picker stable until the host has created the selected page. The
   *  page-changed event can arrive before the open RPC returns; reacting to that
   *  half-finished state briefly draws the page strip or the previous page before
   *  the selected page is ready to take over. */
  let isOpeningTarget = $state(false);
  let hadPageBeforeOpen = $state(false);
  let openingPageKey = $state<string | null>(null);
  /** The address the picker is waiting on, so the offer that was chosen can say
   *  it is loading rather than sitting inert for the whole offscreen load. */
  let openingUrl = $state<string | null>(null);

  function finishOpeningTarget(dismissPicker = true) {
    openingPageKey = null;
    openingUrl = null;
    isOpeningTarget = false;
    if (dismissPicker) choosingTarget = false;
  }

  /**
   * A desktop guest can load while parked offscreen. Keep the picker visible
   * during that load, then move the already-painted guest into the stage in the
   * same update that removes the picker. This avoids the short blank/Loading
   * frame between the two surfaces.
   */
  $effect(() => {
    const key = openingPageKey;
    if (!isOpeningTarget || !key) return;
    const openingEntry = browserStore.pages.get(key);
    if (!openingEntry) return;

    const usesNativeSurface = shouldUseNativeBrowser(
      supportsNativeBrowser(),
      openingEntry.serverId,
      serverConnections.localServerId(),
      openingEntry.page.target.kind,
    );
    if (!usesNativeSurface) {
      // A streamed surface starts its host when the stage subscribes, so it
      // cannot preload without mounting that stage. Keep its existing handoff.
      finishOpeningTarget();
      return;
    }

    nativeSurfaces.mount(key);
    const surfacePhase = nativeSurfaces.phaseOf(key);
    if (
      surfacePhase === "ready" ||
      surfacePhase === "parked" ||
      surfacePhase === "presented" ||
      surfacePhase === "failed" ||
      (openingEntry.page.problem &&
        openingEntry.page.problem.kind !== "no-surface")
    ) {
      finishOpeningTarget();
    }
  });

  /**
   * Whether an inspector opened from here would appear on this user's screen.
   *
   * DevTools are a window on the machine rendering the guest. On the desktop app
   * that is this machine; from a browser or a phone the page may be rendered by
   * a headless browser on a server somewhere else, where a DevTools window would
   * help nobody. Offering the button only where it lands is the honest form.
   */
  const canInspect = $derived(
    !!entry &&
      shouldUseNativeBrowser(
        supportsNativeBrowser(),
        entry.serverId,
        serverConnections.localServerId(),
        entry.page.target.kind,
      ),
  );

  /**
   * Hand the page's address to the user's own browser.
   *
   * Gated on the same fact as DevTools, for the same reason: it is only where
   * this client renders the guest itself that `localhost:<port>` means the same
   * server here as it does in the pane. From a phone it would open the phone's
   * own idea of that port, which is nothing.
   */
  function openExternally() {
    if (!entry) return;
    void localApi.openExternal(entry.page.url);
  }

  function openBrowser(target: BrowserTarget) {
    if (isOpeningTarget) return;
    hadPageBeforeOpen = Boolean(entry);
    isOpeningTarget = true;
    openingUrl = target.kind === "url" ? target.url : null;
    void browserStore
      .open(serverId, { target })
      .then((key) => {
        // The page and active key now exist, but the native guest has not painted
        // yet. The effect above mounts it offscreen and owns the final handoff.
        openingPageKey = key;
      })
      .catch((error: Error) => {
        failed("Couldn't open that browser")(error);
        finishOpeningTarget(false);
      });
  }

  function openTarget(discovered: BrowserDiscoveredTarget) {
    const target: BrowserTarget = { kind: "url", url: discovered.url };
    // The scan is what knows which worktree serves this port; carrying it here
    // is what labels the page by branch and picks the project's profile.
    if (discovered.worktreePath) target.worktreePath = discovered.worktreePath;
    if (discovered.branch) target.branch = discovered.branch;
    if (discovered.projectRoot) target.projectRoot = discovered.projectRoot;
    openBrowser(target);
  }

  function openUrl(url: string) {
    openBrowser({ kind: "url", url });
  }

  /** One route for every size: the picker, the numbers, a dragged edge, and a
   *  pane resizing under a filling page all ask for the same thing. */
  function setViewport(request: BrowserViewportRequest) {
    if (!activeKey) return;
    browserStore.commitViewport(
      activeKey,
      request,
      failed("Couldn't resize the browser"),
    );
  }

  function setAppearance(appearance: BrowserAppearance) {
    if (!activeKey) return;
    void browserStore
      .setAppearance(activeKey, appearance)
      .catch(failed("Couldn't change the browser appearance"));
  }

  /**
   * What the active page's capture can be filed against.
   *
   * Only the host can answer it — the pull request belongs to the branch the
   * page's worktree is on — and the answer goes stale, so it is re-asked when
   * the capture menu opens rather than cached for the life of the pane.
   */
  let evidenceOptions = $state<BrowserEvidenceOptions | null>(null);
  let capturing = $state(false);
  /** Bumped once per completed capture, so the stage can flash the shutter. A
   *  count rather than a flag: two captures in a row must play twice. */
  let captureCount = $state(0);

  function loadEvidenceOptions() {
    if (!activeKey) return;
    void browserStore
      .evidenceOptions(activeKey)
      .then((options) => (evidenceOptions = options))
      .catch(failed("Couldn't work out where this capture could go"));
  }

  // Where a filed capture goes when the user follows the toast back to it. The
  // capture is proof for a task or a pull request, so "look at it there" is the
  // natural next step the toast should offer.
  function openEvidenceTarget(target: BrowserEvidenceTarget) {
    if (target.kind === "task") {
      session.goToTask(target.taskId, "click");
      return;
    }
    void session
      .openPullRequest({ number: target.number }, {
        ctx: session.ctxForDirectory(target.cwd),
      })
      .catch(failed("Couldn't open that pull request"));
  }

  function captureEvidence(target: BrowserEvidenceTarget | undefined) {
    if (!activeKey) return;
    capturing = true;
    void browserStore
      .captureEvidence(activeKey, target)
      .then((evidence) => {
        captureCount += 1;
        toasts.success(
          target ? `Captured — filed on ${evidence.attachedTo}` : "Captured",
          {
            description: evidence.viewport,
            // A filed capture can be followed back to where it landed; a
            // capture-only one has nowhere to go.
            action: target
              ? {
                  label: target.kind === "pr" ? "View PR" : "View task",
                  onAction: () => openEvidenceTarget(target),
                }
              : undefined,
          },
        );
      })
      .catch(failed("Couldn't capture this page"))
      .finally(() => (capturing = false));
  }

  /**
   * Annotation.
   *
   * The bar showing is this pane's own state; which tool is armed is the page's,
   * because the overlay that answers it lives in the guest and any surface
   * looking at that page sees the marks. Closing the bar disarms, so the page
   * cannot be left silently eating clicks after the user moved on.
   */
  let annotating = $state(false);
  const annotationState = $derived(browserStore.annotationsFor(activeKey));
  const markCount = $derived(annotationState?.annotations.length ?? 0);

  /**
   * The comment composer that pops up after a mark is placed.
   *
   * A newly-placed mark opens the popup, focused; what the user types becomes the
   * mark's note and the annotation is synced onto the composer chip. The ids
   * already seen are tracked so only a *new* mark pops the composer — a poll that
   * returns the same marks must not reopen it under the user's hands.
   */
  let commentingMarkId = $state<string | null>(null);
  const seenMarkIds = new Set<string>();
  let commentsSeeded = false;
  let commentPageKey: string | null = null;

  const commentingMark = $derived(
    annotationState?.annotations.find((mark) => mark.id === commentingMarkId) ??
      null,
  );
  const commentingNumber = $derived.by(() => {
    const marks = annotationState?.annotations ?? [];
    const at = marks.findIndex((mark) => mark.id === commentingMarkId);
    if (at === -1) return 0;
    return marks[at]?.number ?? at + 1;
  });
  /** The element the commenting mark points at, for the composer's footer chip —
   *  the same short form the notes used. */
  const commentingContext = $derived.by(() => {
    const element = commentingMark?.element;
    const selected = commentingMark?.elements;
    if (!element) {
      if (!selected?.length) return undefined;
      return selected.length === 1
        ? "1 selected element"
        : `${selected.length} selected elements`;
    }
    if (element.identifier) return `${element.role}#${element.identifier}`;
    return element.label ? `${element.role} · ${element.label}` : element.role;
  });

  $effect(() => {
    if (commentPageKey !== activeKey) {
      commentPageKey = activeKey;
      commentingMarkId = null;
      commentsSeeded = false;
      seenMarkIds.clear();
    }
    const marks = annotationState?.annotations ?? [];
    const ids = new Set(marks.map((mark) => mark.id));
    // A mark that is gone (cleared or removed) is no longer seen, and its open
    // composer closes with it.
    for (const id of seenMarkIds) if (!ids.has(id)) seenMarkIds.delete(id);
    if (commentingMarkId && !ids.has(commentingMarkId)) commentingMarkId = null;
    // The first read only learns the marks already there — reopening a page with
    // marks must not pop the composer for one the user placed long ago.
    if (!commentsSeeded) {
      commentsSeeded = true;
      for (const mark of marks) seenMarkIds.add(mark.id);
      return;
    }
    const fresh = marks.filter((mark) => !seenMarkIds.has(mark.id));
    for (const mark of marks) seenMarkIds.add(mark.id);
    // The newest placed mark is the one to comment on.
    if (fresh.length) {
      const nextMarkId = fresh[fresh.length - 1]!.id;
      if (commentingMarkId && commentingMarkId !== nextMarkId) {
        void removePageMark(commentingMarkId);
      }
      commentingMarkId = nextMarkId;
    }
  });

  // An armed tool is the page's state, not this pane's: it survives the pane
  // closing, and while it is armed the guest's overlay swallows every click in
  // the page. A pane that showed no bar over a page in that state would look
  // like a browser that had stopped responding to the pointer.
  $effect(() => {
    if (entry?.page.annotationTool) annotating = true;
  });

  function leaveAnnotationMode(key: string): Promise<void> {
    commentingMarkId = null;
    return browserStore.setAnnotationTool(key, null);
  }

  function toggleAnnotating() {
    if (!activeKey) return;
    annotating = !annotating;
    if (annotating) {
      void browserStore
        .setAnnotationTool(activeKey, "pick")
        .catch(failed("Couldn't start annotating"));
      return;
    }
    void leaveAnnotationMode(activeKey).catch(
      failed("Couldn't close the annotation tools"),
    );
  }

  // Hiding the pane is leaving annotation mode too. Each completed or skipped
  // comment already removes its own mark, so only the active tool needs to be
  // disarmed here.
  $effect(() => {
    if (surfaceVisible || !annotating || !activeKey) return;
    const key = activeKey;
    annotating = false;
    void leaveAnnotationMode(key).catch(() => {});
  });

  // While a tool is armed the marks are made in the guest, which has no way to
  // tell the pane. Polling is what a client-side overlay would not need — and
  // the price of the overlay living where both surfaces can use it. It runs only
  // while the bar is open and a tool is armed, so a page nobody is annotating
  // costs nothing.
  $effect(() => {
    const key = activeKey;
    if (!annotating || !key || !entry?.page.annotationTool) return;
    const timer = setInterval(() => {
      void browserStore.refreshAnnotations(key).catch(() => {});
    }, 500);
    return () => clearInterval(timer);
  });

  /**
   * Build the attachment from the marks as they are now and drop it on the active
   * composer, replacing an earlier draft for this page rather than adding a
   * second. Each completed comment calls this automatically, so the pill needs
   * no separate Attach action: one structured attachment, no prompt rewrite,
   * and no second comment surface.
   */
  async function syncAnnotationAttachment(): Promise<void> {
    const key = activeKey;
    const current = entry;
    if (!key || !current) return;
    await browserStore.refreshAnnotations(key);
    const state = browserStore.annotationsFor(key);
    if (!state) return;
    const attachment = createAnnotationAttachment({
      page: current.page,
      state,
      serverId: current.serverId,
    });
    if (!attachment) return;
    const input = session.leadingInput;
    const existing = input.attachments.findIndex(
      (candidate) => candidate.id === attachment.id,
    );
    if (existing === -1) input.attachments.push(attachment);
    else {
      input.attachments.splice(
        existing,
        1,
        mergeAnnotationAttachment(input.attachments[existing]!, attachment),
      );
    }
  }

  /**
   * The comment the popup collected. The note lands on the mark, then the whole
   * set is synced onto the chip. The visual mark is then removed from the page;
   * its structured context stays in the stable composer attachment.
   */
  async function commitComment(comment: string) {
    const markId = commentingMarkId;
    commentingMarkId = null;
    if (!activeKey || !markId) return;
    try {
      const note = comment.trim();
      if (!note) {
        await removePageMark(markId);
        return;
      }
      await browserStore.annotate(activeKey, {
        kind: "note",
        annotationId: markId,
        note,
      });
      await syncAnnotationAttachment();
      await removePageMark(markId);
    } catch (error) {
      toasts.error("Couldn't save that comment", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** A mark is transient page markup. Its durable copy lives in the composer. */
  async function removePageMark(markId: string): Promise<void> {
    if (!activeKey) return;
    await browserStore.annotate(activeKey, {
      kind: "remove",
      annotationId: markId,
    });
  }

  function skipComment() {
    const markId = commentingMarkId;
    commentingMarkId = null;
    if (markId) void removePageMark(markId).catch(() => {});
  }

  function clearAnnotations() {
    if (!activeKey) return;
    void browserStore
      .annotate(activeKey, { kind: "clear" })
      .catch(failed("Couldn't clear the marks"));
  }

  function openDevTools() {
    if (!activeKey) return;
    void browserStore
      .openDevTools(activeKey)
      .catch(failed("Couldn't open DevTools"));
  }

  function clearProfile() {
    if (!entry) return;
    void browserStore
      .clearProfile(
        entry.serverId,
        browserProfilePartition(projectRootOf(entry.page), entry.page.profileId),
      )
      .catch(failed("Couldn't clear the browser profile"));
  }

  /** The same address, signed in as another identity. A page's jar is fixed for
   *  its life (ADR 0023), so a second page is the switch — and the only way to
   *  have the admin and the customer signed in at once. */
  function openAsProfile(profileId: string) {
    const current = entry;
    if (!current) return;
    void browserStore
      .open(current.serverId, { target: current.page.target, profileId })
      .then((key) => {
        // A deep-linked pane is pinned to its route param, so setting the
        // store's active page alone would leave this pane on the old identity
        // while the new page loaded out of sight.
        const opened = browserStore.pages.get(key);
        if (opened) activatePage(opened);
      })
      .catch(failed("Couldn't open that browser page"));
  }

  /** The host's refusal to close a page, held until the user answers it. */
  let closeRequest = $state<{
    key: string;
    label: string;
    use: BrowserAgentUse;
  } | null>(null);

  function requestClose(key: string, label: string, force = false) {
    void browserStore
      .close(key, { force })
      .then((result) => {
        closeRequest = result.closed ? null : { key, label, use: result.agentUse };
      })
      .catch(failed("Couldn't close that browser page"));
  }

  /** The strip's scroll box. Held so the page the user is looking at can be
   *  brought back into view: pages arrive from an agent as well as from the
   *  picker, and an active chip parked off the end reads as no page at all. */
  let stripElement = $state<HTMLDivElement | null>(null);

  $effect(() => {
    const key = activeKey;
    const strip = stripElement;
    // A chip can arrive after the key does — the page list loads, or an agent
    // opens a page — so the count is part of what this waits on.
    void pages.length;
    if (!key || !strip) return;
    const chip = strip.querySelector(`[data-page-key="${CSS.escape(key)}"]`);
    chip?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  /** Select a page in both places that can name it. A deep link pins this pane
   *  to its route param, so changing only the store leaves the old page active
   *  and makes the strip look inert. */
  function activatePage(candidate: (typeof pages)[number]) {
    if (annotating && activeKey) {
      const previousKey = activeKey;
      annotating = false;
      void leaveAnnotationMode(previousKey).catch(() => {});
    }
    const key = browserStore.keyOf(
      candidate.serverId,
      candidate.page.browserPageId,
    );
    browserStore.activeKey = key;
    session.router.navigate(
      {
        name: "browser",
        params: {
          browserPageId: candidate.page.browserPageId,
          serverId: candidate.serverId,
        },
      },
      { target: paneId, replace: true },
    );
  }
</script>

<div
  class="relative flex h-full min-h-0 min-w-0 flex-col bg-(--solus-container-bg) {actions.isLeading
    ? ''
    : 'border-l border-(--solus-container-border)'}"
  onfocusin={() => session.router.focusPane(paneId)}
>
  <!-- The pane's chrome row. It is always drawn, empty or not: it is the row
       the pane's own controls sit in, and it is what puts the page strip on the
       same line as the leading pane's header. Its height is the shared chrome
       row rather than a flat 2.5rem, which on the macOS editor is taller so the
       header clears the traffic lights.

       The trailing inset names the cluster's own size as its fallback rather
       than 0: the phone shell draws this pane outside the pane columns, so the
       published variable is absent there and the strip had nothing telling it
       where the close and maximize buttons start. -->
  <div
    class="workspace-titlebar flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center gap-1.5 pr-[max(0.625rem,var(--solus-pane-chrome-inset,6.25rem))] pl-[max(0.625rem,var(--solus-chrome-lead-inset,0px))] pointer-coarse:pr-[max(0.625rem,var(--solus-pane-chrome-inset,9.625rem))]"
  >
    {#if pages.length && (!isOpeningTarget || hadPageBeforeOpen)}
      <!-- The strip scrolls inside its own box, which ends where the pane's
           floating chrome cluster begins. Scrolling the row itself only bought
           extra scroll extent at the end: a padding box is still part of the
           scrollport, so every chip slid under the close and maximize buttons
           on the way past. -->
      <div
        bind:this={stripElement}
        class="no-scrollbar no-drag flex min-w-0 flex-1 items-center gap-2 overflow-x-auto"
      >
        <!-- Pages group under the worktree serving them. The branch distinguishes
             two copies of one app; each page then reads like a browser tab, by its
             document title. A duplicate title gains its route as a qualifier. -->
        {#each pageGroups as group (group.key)}
          {@const holdsActive = group.entries.some(
            (candidate) =>
              browserStore.keyOf(
                candidate.serverId,
                candidate.page.browserPageId,
              ) === activeKey,
          )}
          <div
            class="no-drag flex shrink-0 items-center gap-0.5 rounded-full py-0.5 pr-0.5 pl-2.5 {holdsActive
              ? 'bg-[var(--wash-1)] shadow-[shadow:0_0_0_0.5px_var(--hairline)]'
              : ''}"
          >
            <GitBranch
              class="size-3 shrink-0 text-(--solus-text-tertiary)"
              aria-hidden="true"
            />
            <span
              class="text-workspace-chrome mr-1 ml-1.5 max-w-32 shrink-0 truncate text-(--solus-text-tertiary)"
              title={group.label}
            >
              {group.label}
            </span>
            {#each group.entries as candidate (candidate.page.browserPageId)}
              {@const key = browserStore.keyOf(
                candidate.serverId,
                candidate.page.browserPageId,
              )}
              {@const status = pageStatus(candidate.page)}
              <!-- The close affordance holds its slot at zero opacity, so hovering
                   a page never shifts the label under the pointer. -->
              <div
                data-page-key={key}
                class="group/page flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden rounded-full py-1 pr-1 pl-2.5 transition-colors {key ===
                activeKey
                  ? 'bg-[var(--card)] shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)]'
                  : 'hover:bg-[var(--wash-2)]'}"
              >
                <!-- A page that is loading or has fallen over says so here, not
                     only in the frame: the strip is where the user chooses which
                     page to look at, and a dead dev server is exactly the reason
                     to switch. -->
                {#if status}
                  <span
                    class="size-1.5 shrink-0 rounded-full {status === 'failed'
                      ? 'bg-[var(--failure)]'
                      : 'bg-[var(--warning)]'}"
                    title={status === "failed"
                      ? "This page failed to load"
                      : "Loading"}
                  ></span>
                {/if}
                <!-- An agent working in this page, as the host judges it: the
                     field is present exactly while the close would be refused. -->
                {#if candidate.page.agentUse}
                  <Bot
                    class="size-3 shrink-0 text-[var(--warning)]"
                    aria-label="An agent is using this page"
                  />
                {/if}
                <button
                  type="button"
                  class="text-workspace-chrome min-w-0 max-w-40 truncate font-medium {key ===
                  activeKey
                    ? 'text-(--solus-text-primary)'
                    : 'text-(--solus-text-secondary)'}"
                  title={routeLabel(candidate.page.url)}
                  onclick={() => activatePage(candidate)}
                >
                  {pageLabel(candidate.page, group.entries)}
                </button>
                <button
                  type="button"
                  class="flex size-4 shrink-0 items-center justify-center rounded-full text-(--solus-text-tertiary) transition-opacity group-hover/page:opacity-100 hover:bg-[var(--wash-3)] hover:text-(--solus-text-primary) focus-visible:opacity-100 {key ===
                  activeKey
                    ? 'opacity-50'
                    : 'opacity-0'}"
                  aria-label="Close {routeLabel(candidate.page.url)}"
                  onclick={() =>
                    requestClose(key, routeLabel(candidate.page.url))}
                >
                  <X class="size-2.5" />
                </button>
              </div>
            {/each}
          </div>
        {/each}
      </div>
      <!-- The way to a second page, pinned outside the scroller. Inside it the
           control walked off the end as soon as a third page was open, and the
           only way back to the picker was to scroll the strip. Without it the
           picker is reachable only while no page is open, which makes comparing
           two worktrees a matter of closing the one you are looking at. -->
      <button
        type="button"
        class="no-drag flex size-6 shrink-0 items-center justify-center rounded-full text-(--solus-text-tertiary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
        aria-label="Open another browser page"
        title="Open another browser page"
        onclick={() => {
          choosingTarget = true;
          // The list behind this is as old as the last time the pane opened;
          // a server started since then is exactly what the user is looking for.
          void browserStore
            .loadTargets(serverId)
            .catch(failed("Couldn't scan for dev servers"));
        }}
      >
        <Plus class="size-3.5" />
      </button>
    {/if}
  </div>

  {#if entry && activeKey && !choosingTarget && !isOpeningTarget}
    <BrowserToolbar
      page={entry.page}
      statedViewport={statedViewport ?? entry.page.viewport}
      scale={stageScale}
      onViewport={setViewport}
      onNavigate={(action) =>
        void browserStore
          .navigate(activeKey, { kind: action })
          .catch(failed("Couldn't navigate the browser"))}
      onGoto={(url) =>
        void browserStore
          .navigate(activeKey, { kind: "goto", url })
          .catch(failed("Couldn't open that address"))}
      onAppearance={setAppearance}
      onClearProfile={clearProfile}
      onOpenDevTools={canInspect ? openDevTools : undefined}
      onOpenExternal={canInspect ? openExternally : undefined}
      {annotating}
      onToggleAnnotating={toggleAnnotating}
    >
      {#snippet profile()}
        <BrowserProfileChip
          set={profileSet}
          selectedId={entry.page.profileId}
          onOpenAs={openAsProfile}
          serverId={entry.serverId}
          {projectRoot}
        />
      {/snippet}
      {#snippet capture()}
        <BrowserCaptureButton
          options={evidenceOptions}
          tasks={session.tasksStore.tasks}
          cwd={entry.page.target.kind === "url"
            ? entry.page.target.worktreePath
            : undefined}
          busy={capturing}
          onOpen={loadEvidenceOptions}
          onCapture={captureEvidence}
        />
      {/snippet}
    </BrowserToolbar>
    <BrowserStage
      pageKey={activeKey}
      serverId={entry.serverId}
      page={entry.page}
      statedViewport={statedViewport ?? entry.page.viewport}
      active={surfaceVisible}
      maximized={actions.maximized}
      {captureCount}
      onViewport={setViewport}
      onScale={(value) => (stageScale = value)}
      onReload={() =>
        void browserStore
          .navigate(activeKey, { kind: "reload" })
          .catch(failed("Couldn't reload the browser"))}
      annotation={annotating ? annotationTools : undefined}
      annotationBlocksSurface={Boolean(commentingMarkId)}
    />
    {#snippet annotationTools(scale: number)}
      <!-- The stage/layer hand this the frame's scale and render it full-frame,
           so the pill sits at the bottom and the comment composer lands on its
           own mark — both painting over the native guest and the streamed canvas
           alike. -->
      {@const vp = statedViewport ?? entry.page.viewport}
      {#if commentingMarkId && commentingMark}
        {@const pos = commentAnchorPosition(
          commentingMark.rect,
          scale,
          { width: vp.width * scale, height: vp.height * scale },
          { width: 240, height: 72 },
        )}
        <div
          class="pointer-events-auto absolute z-10"
          style:left="{pos.left}px"
          style:top="{pos.top}px"
        >
          {#key commentingMarkId}
            <BrowserCommentPopup
              markNumber={commentingNumber}
              context={commentingContext}
              onCommit={(comment) => void commitComment(comment)}
              onSkip={skipComment}
            />
          {/key}
        </div>
      {/if}
      <div
        class="pointer-events-auto absolute bottom-4 left-1/2 max-w-full -translate-x-1/2 px-3"
      >
        <BrowserAnnotationBar
          page={entry.page}
          marked={markCount}
          onTool={(tool) =>
            void browserStore
              .setAnnotationTool(activeKey, tool)
              .catch(failed("Couldn't change the annotation tool"))}
          onClear={clearAnnotations}
          onClose={toggleAnnotating}
        />
      </div>
    {/snippet}
  {:else}
    <BrowserTargetPicker
      {targets}
      loading={browserStore.loadingTargets}
      onRefresh={() =>
        void browserStore
          .loadTargets(serverId)
          .catch(failed("Couldn't scan for dev servers"))}
      onOpen={openTarget}
      onOpenUrl={openUrl}
      {openingUrl}
      onCancel={entry && (!isOpeningTarget || hadPageBeforeOpen)
        ? () => (choosingTarget = false)
        : undefined}
    />
  {/if}

  <!-- Over the whole pane rather than anchored to the chip that raised it: the
       close can come from the page strip or from a keyboard. -->
  {#if closeRequest}
    <BrowserCloseConfirm
      pageLabel={closeRequest.label}
      use={closeRequest.use}
      onCancel={() => (closeRequest = null)}
      onConfirm={() => {
        const pending = closeRequest;
        closeRequest = null;
        if (pending) requestClose(pending.key, pending.label, true);
      }}
    />
  {/if}

  <!-- After the content: pane drag rects are collected in DOM order, and a
       chrome row rendered before this cluster would re-cover its no-drag holes. -->
  <PaneChrome
    onClose={actions.close}
    onOpenInSplit={!actions.isLeading ? actions.moveAcross : undefined}
    isLeading={actions.isLeading}
    onToggleMaximize={actions.inPane ? actions.toggleMaximize : null}
    maximized={actions.maximized}
    closeLabel="Close browser"
  />
</div>
