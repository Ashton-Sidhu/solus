<script lang="ts">
  import { untrack } from "svelte";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { versionDiffFiles } from "../lib/app-version-diff";
  import { shortCommit } from "@solus/client-core/app-versions";
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";
  import DiffFiles from "./DiffFiles.svelte";

  /**
   * The source change of one version against the version before it, or of one
   * revision against the revision before it or against `against` (what a
   * rollback moved between), as a flat list of files with no card around it.
   */
  interface Props {
    serverId: string;
    appId: string;
    subject: { kind: "version"; version: number } | { kind: "revision"; commit: string; against?: string };
  }
  let { serverId, appId, subject }: Props = $props();

  // Read when the person opens it; a version and a revision are immutable, so it is not read again:
  // not when the app's row changes, only when the subject does.
  const subjectKey = $derived([serverId, appId, subject.kind, subject.kind === "version" ? subject.version : `${subject.commit}:${subject.against ?? ""}`].join("\n"));
  const diff = $derived.by(() => {
    void subjectKey;
    return untrack(() =>
      subject.kind === "version"
        ? appsStore.versionDiff(serverId, appId, subject.version).then((answer) => ({
            ...answer,
            baseText: answer.base === null ? "The first version: every file is new." : `Against v${answer.base}.`,
          }))
        : appsStore.revisionDiff(serverId, appId, subject.commit, subject.against).then((answer) => ({
            ...answer,
            baseText: answer.base === null ? "The first revision: every file is new." : `Against revision ${shortCommit(answer.base)}.`,
          })),
    );
  });
</script>

{#await diff}
  <p class="m-0 text-xs text-(--solus-text-tertiary)" role="status" aria-busy="true">Loading the changes…</p>
{:then answer}
  <div class="flex min-w-0 flex-col gap-2">
    <p class="m-0 text-xs text-(--solus-text-tertiary)">{answer.baseText}</p>
    <DiffFiles files={versionDiffFiles(answer.patch)} patch={answer.patch} truncated={answer.truncated} />
  </div>
{:catch error}
  <div class="text-[13px] [--prose-ink-strong:var(--solus-text-primary)]" role="alert">
    <MarkdownAlert alertType="error">
      {#snippet content()}{error instanceof Error ? error.message : "Could not load the changes."}{/snippet}
    </MarkdownAlert>
  </div>
{/await}
