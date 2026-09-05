<script lang="ts">
  import { Check as CheckIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import SandboxFrame from "../artifact/SandboxFrame.svelte";
  import ArtifactRail from "../artifact/ArtifactRail.svelte";

  /**
   * An `.html` file rendered in the same sandboxed frame agent HTML runs in.
   *
   * The frame has no origin, so a relative `src` or `href` inside the file
   * resolves against nothing and will not load. That is expected: this is a
   * preview of one document, not a served site, and reaching back into the
   * project's filesystem to satisfy it would be a different feature.
   */
  interface Props {
    contents: string;
    /** A truncated read is half a document; the caller keeps source in that
     *  case, and this component is not mounted. */
    title: string;
  }

  let { contents, title }: Props = $props();

  const session = getWorkspaceContext();

  let saving = $state(false);
  let saved = $state<{ workId: string; title: string } | null>(null);

  async function saveAsArtifact() {
    if (saving || saved) return;
    saving = true;
    try {
      saved = await session.createArtifact(contents);
    } finally {
      saving = false;
      requestInputFocus();
    }
  }
</script>

<div class="min-h-0 flex-1 overflow-auto p-4" data-testid="html-file-preview">
  <SandboxFrame html={contents}>
    {#snippet actions()}
      {#if !saved}
        <button
          type="button"
          class="artifact-action is-labelled"
          data-testid="html-file-save"
          disabled={saving}
          onclick={saveAsArtifact}
        >
          {saving ? "Saving…" : "Save as artifact"}
        </button>
      {:else}
        <span class="artifact-action is-labelled" aria-live="polite">
          <CheckIcon size={12} />
          Saved
        </span>
      {/if}
    {/snippet}
  </SandboxFrame>
  {#if saved}
    <ArtifactRail workId={saved.workId} title={saved.title} />
  {:else}
    <span class="sr-only">{title}</span>
  {/if}
</div>
