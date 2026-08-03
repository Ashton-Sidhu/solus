<script lang="ts">
  import type { Snippet } from "svelte";
  import { FolderIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { isWorkspaceDir } from "../../lib/paths";
  import {
    faviconCandidates,
    rememberFavicon,
    resolvedFavicon,
  } from "../../lib/project-favicon";
  import WorkspaceMark from "./WorkspaceMark.svelte";

  let {
    projectRoot,
    class: className = "size-3.5",
    fallback,
  }: {
    projectRoot: string;
    class?: string;
    /** Stands in when the project has no favicon of its own. Folder glyph by
     *  default; the sidebar hands it a lettered mark instead. */
    fallback?: Snippet;
  } = $props();

  const session = getWorkspaceContext();
  const isWorkspace = $derived(
    isWorkspaceDir(projectRoot, session.staticInfo?.workspacePath),
  );
  const candidates = $derived(faviconCandidates(projectRoot));

  /** Where the probe for the root currently on screen has got to. Replaced
   *  rather than mutated when the root changes, so a component reused for a
   *  different project never shows the previous one's mark, and a root already
   *  resolved this session starts settled — no probe, and so no flash. */
  let probe = $state({ root: "", index: 0, settled: false, url: null as string | null });
  const state = $derived.by(() => {
    if (probe.root === projectRoot) return probe;
    const known = resolvedFavicon(projectRoot);
    return { root: projectRoot, index: 0, settled: known !== undefined, url: known ?? null };
  });

  /** The candidate on screen — the resolved mark once known, else the one
   *  currently being tried. */
  const src = $derived(state.url ?? candidates[state.index]);

  function settle(url: string) {
    rememberFavicon(projectRoot, url);
    probe = { root: projectRoot, index: state.index, settled: true, url };
  }

  function tryNextCandidate() {
    if (state.settled) return;
    const next = state.index + 1;
    if (next >= candidates.length) {
      rememberFavicon(projectRoot, null);
      probe = { root: projectRoot, index: next, settled: true, url: null };
      return;
    }
    probe = { root: projectRoot, index: next, settled: false, url: null };
  }
</script>

<span
  class="relative inline-flex flex-shrink-0 items-center justify-center {className}"
>
  {#if isWorkspace}
    <WorkspaceMark class="size-full" />
  {:else}
    <!-- Nothing stands in while the probe runs. Showing the fallback first and
         swapping it out is what reads as a stutter — the mark is either the
         project's own or it isn't, and the answer arrives within a frame or
         two off local disk. -->
    {#if state.settled && !state.url}
      {#if fallback}
        {@render fallback()}
      {:else}
        <FolderIcon
          size="100%"
          weight="fill"
          class="text-(--solus-text-tertiary)"
        />
      {/if}
    {:else}
      <img
        {src}
        alt=""
        aria-hidden="true"
        class="absolute inset-0 size-full rounded-[0.1875rem] object-contain transition-opacity duration-150 {state.url
          ? 'opacity-100'
          : 'opacity-0'}"
        onload={() => settle(src)}
        onerror={tryNextCandidate}
      />
    {/if}
  {/if}
</span>
