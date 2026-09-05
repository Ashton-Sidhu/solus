<script lang="ts">
  import { untrack } from "svelte";
  import { Code as CodeIcon, Eye as EyeIcon, Check as CheckIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import ArtifactRail from "../artifact/ArtifactRail.svelte";
  import SandboxFrame from "../artifact/SandboxFrame.svelte";
  import { getHtmlBlockOrigin } from "./lib/html-block-origin";

  /**
   * An HTML block in a reply: markup the agent wrote to be looked at, running
   * live in the sandbox frame with no tool call behind it.
   *
   * A block is ephemeral — it is the message, and it has no work id until the
   * reader asks for one. "Save as artifact" is what gives it identity; the rail
   * that appears afterwards is the same one an `artifact` work carries.
   *
   * The Preview/Source toggle is deliberately local state: a transcript is not
   * a document, so which way a reader last looked at a block is not something
   * to persist or to sync across the clients reading the same session.
   */
  interface Props {
    html: string;
    /** Snippets that were rendered by hand start on source, so the reader ends
     *  up where they asked to be rather than one click away from it. */
    initialMode?: "preview" | "source";
  }

  let { html, initialMode = "preview" }: Props = $props();

  const session = getWorkspaceContext();
  const origin = getHtmlBlockOrigin();

  let mode = $state<"preview" | "source">(untrack(() => initialMode));
  let saving = $state(false);
  let saved = $state<{ workId: string; title: string } | null>(null);

  async function saveAsArtifact() {
    if (saving || saved) return;
    saving = true;
    try {
      saved = await session.createArtifact(html, origin?.().tabId);
    } finally {
      saving = false;
      requestInputFocus();
    }
  }
</script>

<div class="html-block" data-testid="html-block">
  {#if mode === "preview"}
    <SandboxFrame {html}>
      {#snippet actions()}
        {#if !saved}
          <button
            type="button"
            class="artifact-action is-labelled"
            data-testid="html-block-save"
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
        <button
          type="button"
          class="artifact-action"
          data-testid="html-block-source"
          aria-label="Show HTML source"
          title="Show source"
          onclick={() => (mode = "source")}
        >
          <CodeIcon size={14} />
        </button>
      {/snippet}
    </SandboxFrame>
  {:else}
    <CodeBlock text={html} lang="html">
      {#snippet actions()}
        <button
          type="button"
          class="solus-code-action"
          data-testid="html-block-preview"
          onclick={() => (mode = "preview")}
        >
          <EyeIcon size={11} />
          Preview
        </button>
        {#if !saved}
          <button
            type="button"
            class="solus-code-action"
            data-testid="html-block-save"
            disabled={saving}
            onclick={saveAsArtifact}
          >
            {saving ? "Saving…" : "Save as artifact"}
          </button>
        {/if}
      {/snippet}
    </CodeBlock>
  {/if}

  {#if saved}
    <ArtifactRail
      workId={saved.workId}
      title={saved.title}
      linkContext={origin?.().linkContext}
    />
  {/if}
</div>

<style>
  .html-block {
    margin-block: 0.5rem;
  }
</style>
