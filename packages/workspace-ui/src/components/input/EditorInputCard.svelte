<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "../../lib/utils";
  import { isChat } from "@solus/contracts/chat";
  import { getWorkspaceContext } from "../../contexts";
  import { hasSessionStarted } from "../../lib/sessionUtils";
  import InputBar from "./InputBar.svelte";
  import InputBarHeader from "./InputBarHeader.svelte";
  import InputToolbar from "./InputToolbar.svelte";
  import { canDriveSession, VIEW_ONLY_REASON } from "../../contexts/sharing/resource-roles";
  import { checkoutPlace, runHost } from "../../contexts/workspace/run-location";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import HostUnavailable from "../conversation/HostUnavailable.svelte";
  import { isWaitingForHost } from "@solus/client-core/host-readiness";
  import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";

  interface Props {
    active: boolean;
    class?: string;
    tabId?: string;
    /** The pane this card fills, when it fills one of its own. Unset by the
     *  workspace's own dock, which belongs to the leading pane. */
    paneId?: string;
    onAttachFile: () => void | Promise<void>;
    onScreenshot?: (() => void | Promise<void>) | null;
    trailingActions?: Snippet;
    /** This client may only read the conversation (a viewer on a shared
     *  session): the bar says so in place of a prompt and the toolbar goes
     *  inert. Unset, the bar follows the session's own read-only state. */
    readOnlyReason?: string | null;
  }

  let {
    active,
    class: className,
    tabId,
    paneId,
    onAttachFile,
    onScreenshot,
    trailingActions,
    readOnlyReason = null,
  }: Props = $props();

  const session = getWorkspaceContext();
  // A pinned card names its tab; the workspace's own dock composes for whatever
  // chat is active. Resolving that here means the bar below is handed a session
  // outright and never has to guess one from the tab strip.
  const targetTabId = $derived(tabId ?? session.activeTabId);
  const sess = $derived(session.sessionFor(targetTabId));
  const started = $derived(hasSessionStarted(sess));
  // A member who may only read a shared session gets an inert toolbar too: the
  // host refuses an attachment, a screenshot, or a run change from them.
  const effectiveReadOnlyReason = $derived(
    readOnlyReason ??
      (sess && !canDriveSession(runHost(sess.run), sess.id) ? VIEW_ONLY_REASON : null),
  );
  let prompt = $derived(session.inputFor(targetTabId));
  const hostState = $derived(sess ? serversStore.readinessFor(runHost(sess.run)) : null);
  const awayHostId = $derived(sess && hostState?.away ? runHost(sess.run) : null);
  // Inside the grace the composer stays, and one whisper over it says the host
  // is coming back. The window's own host says so on the connection overlay,
  // and the desktop's local host runs beside the window.
  const graceHostId = $derived(
    sess &&
      hostState &&
      !hostState.away &&
      isWaitingForHost(hostState.readiness) &&
      runHost(sess.run) !== LOCAL_SERVER_ID &&
      runHost(sess.run) !== serversStore.windowHostId
      ? runHost(sess.run)
      : null,
  );

  // The workspace dock (no tab of its own) steps aside while a draft holds the
  // leading pane: the draft's composer is the primary then, and it — not this
  // hidden dock — must own app focus and the shared mic. Two primaries would
  // both auto-claim voice, and whichever won left the visible composer mute.
  const isPrimary = $derived(
    tabId === undefined && session.router.destination.name !== "draft",
  );

  let focused = $state(false);
</script>

<div class={cn("flex flex-col", className)}>
  <!-- A host past its grace cannot take a prompt: the conversation above shows
       its state, and the composer steps aside. -->
  {#if !awayHostId}
    {#if graceHostId}
      <HostUnavailable serverId={graceHostId} variant="whisper" />
    {/if}
  <!--
    Destination is only editable pre-flight, so the strip mounts for exactly
    that long. `{#if}` beats the renderer's usual hide-don't-unmount rule here:
    it flips once per session lifetime, and the alternative is keeping a
    GitDropdown and a RunOnPicker alive for every tab forever. It sits above the
    card rather than inside it: it describes the session about to start, not the
    message being composed.
  -->
  {#if !started}
    <!-- Raw `tabId`, not the active-resolved one: unset for the workspace dock,
         which is what keeps it answering the global git-dropdown shortcut. -->
    <InputBarHeader {active} sourceId={tabId} {paneId} />
  {/if}
  <!--
    One card, one hairline, one accent. The card sits flat on the page — a
    half-pixel outline and nothing behind it — so terracotta is spent on focus
    and on send, never on the resting border.
  -->
  <div
    data-composer-surface
    class={cn(
      // The `composer` container. The toolbar row's disclosure ladder measures
      // this card, so it narrows identically whether the cause is a phone, a
      // laptop, or a companion pane opening beside it. During the fold, the bar
      // tweens this card out of flow while the root holds its final height.
      "@container/composer overflow-hidden rounded-2xl bg-(--solus-input-pill-bg) px-3 pb-3 transition-[box-shadow] duration-[180ms]",
      focused
        ? "shadow-[shadow:0_0_0_0.0625rem_color-mix(in_oklch,var(--solus-accent)_34%,transparent),0_0_0_0.25rem_color-mix(in_oklch,var(--solus-accent)_9%,transparent)]"
        : "shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border)]",
    )}
    onfocusin={() => (focused = true)}
    onfocusout={() => (focused = false)}
  >
    <InputBar
      {active}
      spacious
      maxHeight={260}
      sessionId={sess?.id ?? null}
      tabId={targetTabId}
      {isPrimary}
      {paneId}
      run={sess?.run}
      readOnlyReason={effectiveReadOnlyReason}
      bind:prompt
    >
      {#snippet leadingActions()}
        <InputToolbar
          {active}
          spacious
          showDestination={false}
          tabId={targetTabId}
          {isPrimary}
          readOnly={!!effectiveReadOnlyReason}
          {onAttachFile}
          {onScreenshot}
          {trailingActions}
          chatSourceId={!started && isChat(checkoutPlace(sess?.run)?.path) ? targetTabId : null}
        />
      {/snippet}
    </InputBar>
  </div>
  {/if}
</div>
