<script lang="ts">
  import {
    BookmarkPlus as SaveArtifactIcon,
    Code as CodeIcon,
    Download as DownloadIcon,
    PanelRight as PanelRightIcon,
  } from "@lucide/svelte";
  import { getSurfaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import ArtifactRail from "../artifact/ArtifactRail.svelte";
  import SandboxFrame from "../artifact/SandboxFrame.svelte";
  import { lastReportedHeight } from "../artifact/lib/artifact-view";
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import { downloadPayload } from "../work/lib/work-export";
  import { htmlBlockFileName } from "./lib/html-block";
  import { getHtmlBlockOrigin } from "./lib/html-block-origin";
  import { HtmlWithLocalImages } from "./lib/html-local-images.svelte";
  import { getMarkdownImageContext } from "./lib/markdown-image";

  /**
   * An HTML block in a reply: markup the agent wrote to be looked at, running
   * live in the sandbox frame with no tool call behind it.
   *
   * A block is ephemeral — it is the message, and it has no work id until the
   * reader asks for one. "Save as artifact" is what gives it identity; the rail
   * that appears above it afterwards is the same one an `artifact` work carries.
   * "Open in split" needs that identity too, so it saves first when it must.
   * "Save as HTML" writes the markup to the device and leaves the block as it is.
   * Local images are written into the page first, so both saves keep them.
   */
  interface Props {
    html: string;
    /** A snippet the reader rendered by hand keeps a way back to its source.
     *  A block that rendered on its own has no source view. */
    onShowSource?: () => void;
  }

  let { html, onShowSource }: Props = $props();

  // Saving a block as an artifact writes it through a session; a client with
  // no workspace (the cloud console) can only download it.
  const session = getSurfaceContext().workspace;
  const origin = getHtmlBlockOrigin();
  const images = getMarkdownImageContext();
  const page = new HtmlWithLocalImages(
    () => html,
    () => {
      const serverId = images?.serverId();
      return serverId ? { serverId, ctx: images?.ctx() } : null;
    },
  );

  let saving = $state(false);
  let saved = $state<{ workId: string; title: string } | null>(null);

  async function ensureSaved(): Promise<{ workId: string; title: string } | null> {
    if (saved) return saved;
    if (saving || !session) return null;
    saving = true;
    try {
      saved = await session.createArtifact(page.html ?? html, origin?.().tabId);
      return saved;
    } finally {
      saving = false;
    }
  }

  async function saveAsArtifact() {
    await ensureSaved();
    requestInputFocus();
  }

  async function openInSplit() {
    const work = await ensureSaved();
    if (work) session?.openWork(work.workId);
    requestInputFocus();
  }

  function saveAsHtml() {
    downloadPayload(htmlBlockFileName(html), "text/html", { contents: page.html ?? html, encoding: "utf8" });
    requestInputFocus();
  }
</script>

{#snippet action(
  label: string,
  testId: string,
  onclick: () => void,
  icon: typeof DownloadIcon,
  disabled = false,
)}
  {@const Icon = icon}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button
          {...tooltipProps}
          type="button"
          class="artifact-action"
          data-testid={testId}
          aria-label={label}
          {disabled}
          {onclick}
        >
          <Icon size={14} />
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={label} />
  </TooltipUI.Root>
{/snippet}

<div
  class="html-block {origin ? 'w-full' : ''}"
  data-testid="html-block"
  data-conversation-preview={origin ? true : undefined}
>
  {#if saved}
    <ArtifactRail
      workId={saved.workId}
      title={saved.title}
      linkContext={origin?.().linkContext}
    />
  {/if}
  {#if page.html === null}
    <!-- The page's local images are loading. Hold the height it had last time. -->
    <div class="overflow-hidden rounded-2xl" style="height:{lastReportedHeight(html) ?? 120}px">
      <ContentSkeleton label="Loading artifact" preview />
    </div>
  {:else}
    <SandboxFrame html={page.html} heightKey={html} expandable={false}>
      {#snippet actions()}
        {#if onShowSource}
          {@render action("Show source", "html-block-source", onShowSource, CodeIcon)}
        {/if}
        {@render action("Save as HTML", "html-block-download", saveAsHtml, DownloadIcon)}
        {#if !saved && session}
          <!-- Once saved, the rail above names the artifact; the action goes away. -->
          {@render action(
            saving ? "Saving…" : "Save as artifact",
            "html-block-save",
            saveAsArtifact,
            SaveArtifactIcon,
            saving,
          )}
        {/if}
        {#if session}
          {@render action("Open in split", "html-block-open-split", openInSplit, PanelRightIcon, saving)}
        {/if}
      {/snippet}
    </SandboxFrame>
  {/if}
</div>

<style>
  .html-block {
    margin-block: 0.5rem;
  }
</style>
