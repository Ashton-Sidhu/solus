<script lang="ts">
  import {
    CircleCheck as PassedIcon,
    CircleDashed as UnknownIcon,
    CircleX as FailedIcon,
    EyeOff as HiddenIcon,
    ShieldCheck as VerifiedIcon,
    TriangleAlert as AlertIcon,
    Info as InfoIcon,
  } from "@lucide/svelte";
  import { tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { parsePatchFileList } from "../../lib/pierre-diff";
  import { diffFileStats } from "../../lib/diffTreeAdapter";
  import DiffHeatMap from "../diff/DiffHeatMap.svelte";
  import DiffFileCardHeader from "../diff/DiffFileCardHeader.svelte";
  import DiffLayoutToggle from "../diff/DiffLayoutToggle.svelte";
  import DiffTokenToggle from "../diff/DiffTokenToggle.svelte";
  import { diffViewPreferences } from "../../lib/diff-view-preferences.svelte";
  import { splitPatchByFile } from "../pr-review/guide/lib/guide-data";
  import FindingRow from "./FindingRow.svelte";
  import type { TurnChange } from "./insights.store.svelte";
  import {
    CHECK_KIND_LABELS,
    verdictSummary,
    type CheckResult,
    type TurnVerification,
    type VerdictTone,
  } from "./lib/turn-verification";

  /**
   * Can the reader trust what this turn changed?
   *
   * The verdict leads. Under it, where the change went (the diff heat map) and
   * the checks that ran, then the change itself: one diff card per file, with
   * the guide's card header and the diff panel's layout and token controls.
   * A file opens its diff in place, from its card or from its cell on the map.
   */
  interface Props {
    verification: TurnVerification;
    change: TurnChange | null;
    /** The turn is running: git records its change when it ends. */
    isLive: boolean;
    projectRoot: string | null;
    onOpenSpan: (spanId: string) => void;
    loadRepoFiles: (repoRoot: string) => Promise<readonly string[] | null>;
  }

  let { verification, change, isLive, projectRoot, onOpenSpan, loadRepoFiles }: Props = $props();

  const TONE = {
    good: { icon: VerifiedIcon, color: "var(--solus-status-complete)" },
    warning: { icon: AlertIcon, color: "var(--warning)" },
    failure: { icon: FailedIcon, color: "var(--failure)" },
    neutral: { icon: InfoIcon, color: null },
  } satisfies Record<VerdictTone, { icon: typeof InfoIcon; color: string | null }>;
  const RESULT = {
    passed: { icon: PassedIcon, color: "var(--solus-status-complete)", label: "Passed" },
    failed: { icon: FailedIcon, color: "var(--failure)", label: "Failed" },
    hidden: { icon: HiddenIcon, color: null, label: "Piped, so the result is not known" },
    unknown: { icon: UnknownIcon, color: null, label: "No result reported" },
  } satisfies Record<CheckResult, { icon: typeof InfoIcon; color: string | null; label: string }>;

  const summary = $derived(verdictSummary(verification.verdict, projectRoot));
  const patch = $derived(change?.status === "ready" ? change.patch : "");
  const diffFiles = $derived(patch ? parsePatchFileList(patch) : []);
  const patchByPath = $derived(splitPatchByFile(patch));
  const fileRows = $derived(
    diffFiles.map((file) => ({ path: file.name, ...diffFileStats(file), patch: patchByPath.get(file.name) ?? "" })),
  );
  /** Nothing changed, checked, or failed: the section would only say so. */
  const hasContent = $derived(summary !== null || verification.failures.length > 0 || diffFiles.length > 0);

  const openPaths = new SvelteSet<string>();
  let diffListEl: HTMLElement | undefined = $state();
  let diffListWidth = $state(0);
  /** Two columns need room; below this the layout control is hidden and the
   *  diffs stack, as the diff panel does. The stored choice is kept. */
  const SPLIT_MIN_WIDTH = 640;
  const effectiveDiffStyle = $derived(
    diffListWidth >= SPLIT_MIN_WIDTH ? diffViewPreferences.diffStyle : "unified",
  );

  function toggleFile(path: string): void {
    if (openPaths.has(path)) openPaths.delete(path);
    else openPaths.add(path);
  }

  /** A cell on the map opens that file's diff below and brings it into view. */
  async function openFileFromMap(path: string): Promise<void> {
    openPaths.add(path);
    await tick();
    diffListEl?.querySelector(`[data-file="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
</script>

{#if hasContent}
  <section
    class="flex flex-col rounded-xl bg-card shadow-[shadow:var(--insights-card-shadow)]"
    aria-label="Result"
  >
    <header class="flex h-10 items-center gap-3 px-5 shadow-[inset_0_-0.5px_0_var(--hairline)]">
      <h2 class="m-0 shrink-0 text-insights-summary font-medium">Result</h2>
    </header>

    {#if summary}
      {@const tone = TONE[summary.tone]}
      <div class="px-3 pt-2">
        <FindingRow icon={tone.icon} color={tone.color} title={summary.title} detail={summary.detail} />
      </div>
    {/if}

    <div class="grid gap-x-6 gap-y-4 px-5 pt-3 pb-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div class="flex min-w-0 flex-col gap-2">
        <h3 class="m-0 text-insights-chrome font-medium text-muted-foreground">Changes</h3>
        {#if isLive}
          <p class="m-0 text-insights-chrome text-muted-foreground">Git records the change when the turn ends.</p>
        {:else if change === null || change.status === "loading"}
          <div
            class="flex h-72 items-center justify-center rounded-lg bg-[var(--wash-1)] text-insights-chrome text-muted-foreground"
          >
            Reading the change from git
          </div>
        {:else if diffFiles.length > 0}
          <div class="h-72">
            <DiffHeatMap
              files={diffFiles}
              onOpenFile={(path) => void openFileFromMap(path)}
              repoRoot={projectRoot}
              {loadRepoFiles}
              class="p-0 text-insights-chrome"
            />
          </div>
        {:else}
          <p class="m-0 text-insights-chrome text-muted-foreground">
            {change.status === "ready"
              ? "Git recorded no file change in this turn."
              : change.status === "failed"
                ? "The change could not be read from the host."
                : "Git did not record this turn's change."}
          </p>
        {/if}
      </div>

      <div class="flex min-w-0 flex-col gap-1">
        <h3 class="m-0 text-insights-chrome font-medium text-muted-foreground">Checks</h3>
        {#if verification.targets.length === 0 && verification.failures.length === 0}
          <p class="m-0 text-insights-chrome text-muted-foreground">No test, type check, or lint ran.</p>
        {/if}
        <ul class="m-0 -mx-2 flex list-none flex-col gap-px p-0">
          {#each verification.targets as target (target.command)}
            {@const result = RESULT[target.last.result]}
            <li class="m-0">
              <FindingRow
                icon={result.icon}
                color={result.color}
                title={target.command}
                detail="{CHECK_KIND_LABELS[target.kind]} · {result.label}{target.runs.length > 1
                  ? ` · ${target.runs.length} runs`
                  : ''}"
                openTitle="Open the last run in the trace"
                onOpen={() => onOpenSpan(target.last.spanId)}
              />
            </li>
          {/each}
          {#each verification.failures as failure (failure.spanId)}
            <li class="m-0">
              <FindingRow
                icon={FailedIcon}
                color="var(--failure)"
                title={failure.command}
                detail="Failed{failure.exitCode == null ? '' : ` with exit ${failure.exitCode}`}, not run again{failure.error
                  ? ` · ${failure.error}`
                  : ''}"
                onOpen={() => onOpenSpan(failure.spanId)}
              />
            </li>
          {/each}
        </ul>
      </div>
    </div>

    {#if fileRows.length > 0}
      <div
        class="flex flex-col gap-2 px-5 pt-3 pb-4 shadow-[inset_0_0.5px_0_var(--hairline)]"
        bind:this={diffListEl}
        bind:clientWidth={diffListWidth}
      >
        <div class="flex items-center gap-2">
          <h3 class="m-0 flex-1 text-insights-chrome font-medium text-muted-foreground">Diffs</h3>
          {#if diffListWidth >= SPLIT_MIN_WIDTH}
            <DiffLayoutToggle
              diffStyle={diffViewPreferences.diffStyle}
              onSetStyle={(style) => diffViewPreferences.setDiffStyle(style)}
            />
          {/if}
          <DiffTokenToggle
            tokenHighlight={diffViewPreferences.tokenHighlight}
            onToggle={() => diffViewPreferences.toggleTokenHighlight()}
          />
        </div>
        {#each fileRows as file (file.path)}
          {@const isOpen = openPaths.has(file.path)}
          <div
            class="scroll-mt-6 overflow-hidden rounded-2xl border border-(--solus-art-border) bg-(--solus-art-surface)"
            data-file={file.path}
          >
            <DiffFileCardHeader path={file.path} open={isOpen} onToggle={() => toggleFile(file.path)}>
              {#snippet trailing()}
                <span class="shrink-0 text-chrome-shelf tabular-nums">
                  <span class="text-(--solus-art-positive)">+{file.additions}</span>
                  <span class="text-(--solus-art-negative)">−{file.deletions}</span>
                </span>
              {/snippet}
            </DiffFileCardHeader>
            {#if isOpen}
              <div class="overflow-x-auto bg-(--solus-diff-surface)">
                {#if file.patch}
                  {#await import("../diff/Diff.svelte")}
                    <p class="m-0 px-3 py-3 text-insights-chrome text-muted-foreground">Loading the diff</p>
                  {:then diffModule}
                    {@const Diff = diffModule.default}
                    <Diff patch={file.patch} diffStyle={effectiveDiffStyle} tokenHighlight={diffViewPreferences.tokenHighlight} />
                  {/await}
                {:else}
                  <p class="m-0 px-3 py-3 text-insights-chrome text-muted-foreground">
                    No text diff for this file (binary, or a rename with no change).
                  </p>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}
