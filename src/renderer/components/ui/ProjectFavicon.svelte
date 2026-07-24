<script lang="ts">
  import { FolderIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { isWorkspaceDir } from "../../lib/paths";
  import WorkspaceMark from "./WorkspaceMark.svelte";

  let { projectRoot }: { projectRoot: string } = $props();

  const session = getWorkspaceContext();
  const isWorkspace = $derived(
    isWorkspaceDir(projectRoot, session.staticInfo?.workspacePath),
  );

  const filenames = [
    "favicon.ico",
    "favicon.svg",
    "favicon.png",
    "favicon.webp",
    "favicon.jpg",
    "favicon.jpeg",
  ];

  let candidateIndex = $state(0);
  let loaded = $state(false);

  const faviconUrl = $derived.by(() => {
    const root = projectRoot.replace(/\/+$/, "");
    const path = `${root}/${filenames[candidateIndex]}`;
    return `solus-artifact://local/?p=${encodeURIComponent(path)}`;
  });

  function tryNextCandidate() {
    loaded = false;
    candidateIndex += 1;
  }
</script>

<span class="relative flex size-3.5 flex-shrink-0 items-center justify-center">
  {#if isWorkspace}
    <WorkspaceMark class="size-3.5 text-(--solus-brand-gold)" />
  {:else}
    <FolderIcon
      size={13}
      weight="fill"
      class="text-(--solus-text-tertiary) transition-opacity duration-150 {loaded
        ? 'opacity-0'
        : 'opacity-100'}"
    />
    {#if candidateIndex < filenames.length}
      <img
        src={faviconUrl}
        alt=""
        aria-hidden="true"
        class="absolute inset-0 size-3.5 rounded-[0.1875rem] object-contain opacity-0 transition-opacity duration-150 {loaded
          ? 'opacity-100'
          : ''}"
        onload={() => (loaded = true)}
        onerror={tryNextCandidate}
      />
    {/if}
  {/if}
</span>
