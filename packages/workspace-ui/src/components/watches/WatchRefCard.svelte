<script lang="ts">
  import { untrack } from "svelte";
  import { Eye as EyeIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import TranscriptCard from "../conversation/TranscriptCard.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import { canCancelWatch, canPauseWatch, watchRail } from "./lib/watch-format";
  import { watchEndedWithoutCondition } from "../../contexts/watches/watch-notice";

  interface Props {
    ref: { watchId?: string; reason: string; command?: string };
    /** The session the watch wakes, and its host: the card loads that
     *  session's watches when nothing else has. */
    sessionId?: string;
    serverId?: string;
    skipMotion?: boolean;
  }
  let { ref, sessionId, serverId, skipMotion = false }: Props = $props();

  const store = getWorkspaceContext().watchesStore;
  const watch = $derived(
    ref.watchId
      ? store.get(ref.watchId)
      : sessionId
        ? store.forSession(sessionId).find((candidate) =>
            candidate.reason === ref.reason && candidate.probe?.command === ref.command)
        : undefined,
  );
  const loadError = $derived(sessionId ? store.loadErrors.get(sessionId) : undefined);
  let expanded = $state(false);
  let busy = $state(false);
  let error = $state("");

  $effect(() => {
    const hostId = serverId;
    const id = sessionId;
    if (hostId && id) return untrack(() => store.watchSession(hostId, id));
  });

  // The rail counts down to the next check, so it reads the clock while the
  // watch waits and stops once it does not.
  let nowTick = $state(Date.now());
  $effect(() => {
    if (watch?.status !== "waiting") return;
    const timer = setInterval(() => (nowTick = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const railText = $derived(
    error || loadError || (watch ? watchRail(watch, nowTick) : "watch no longer available"),
  );
  const lastOutput = $derived(watch?.lastResult?.outputTail ?? "");

  async function run(command: "pause" | "resume" | "cancel") {
    if (!watch || busy) return;
    busy = true;
    error = "";
    try {
      await store[command](watch);
      requestInputFocus();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not change the watch.";
    } finally {
      busy = false;
    }
  }
</script>

{#snippet stateActions()}
  {#if watch && canPauseWatch(watch)}
    <TranscriptCardAction kind="ghost" disabled={busy} onclick={() => run("pause")}>Pause</TranscriptCardAction>
  {:else if watch?.status === "paused"}
    <TranscriptCardAction kind="ghost" disabled={busy} onclick={() => run("resume")}>Resume</TranscriptCardAction>
  {/if}
{/snippet}

{#snippet cancelMenu()}
  <TranscriptCardAction kind="item" destructive disabled={busy} onclick={() => run("cancel")}>
    Cancel watch
  </TranscriptCardAction>
{/snippet}

{#snippet lastResultBody()}
  {#if watch?.endReason}
    <p class="m-0 mb-1.5 text-xs text-(--solus-text-secondary)">{watch.endReason}</p>
  {/if}
  <pre class="m-0 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-(--solus-text-secondary)">{lastOutput}</pre>
{/snippet}

<TranscriptCard
  title={watch?.reason ?? ref.reason}
  type="watch"
  target={watch?.probe?.command ?? ref.command}
  ariaLabel={`Watch: ${ref.reason}`}
  expanded={lastOutput ? expanded : undefined}
  onOpen={lastOutput ? () => (expanded = !expanded) : undefined}
  failed={!!error || !!loadError || (!!watch && watchEndedWithoutCondition(watch))}
  bodyLayout="prose"
  actions={watch && (canPauseWatch(watch) || watch.status === "paused") ? stateActions : undefined}
  menu={watch && canCancelWatch(watch) ? cancelMenu : undefined}
  body={lastOutput ? lastResultBody : undefined}
  {skipMotion}
>
  {#snippet glyph()}<EyeIcon />{/snippet}
  {#snippet rail()}
    <span aria-live="polite">{railText}</span>
  {/snippet}
</TranscriptCard>
