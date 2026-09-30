<script lang="ts">
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import { Check as CheckIcon, Copy as CopyIcon } from "@lucide/svelte";
  import { getSurfaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { isRasterImage, mediaTypeFor } from "@solus/contracts/media-types";
  import { HostMediaUrl, type HostMediaRequest } from "../../lib/host-media-url.svelte";
  import { exportFileName } from "../pickers/lib/export-file-name";
  import { downloadPayload } from "../work/lib/work-export";
  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";
  import ArtifactRail from "./ArtifactRail.svelte";
  import ArtifactSkeleton from "./ArtifactSkeleton.svelte";
  import SandboxFrame from "./SandboxFrame.svelte";

  /**
   * An `artifact` render in a conversation, a task, or a pane: the sandboxed
   * frame plus everything that belongs to the artifact rather than to the
   * frame — image artifacts, the error and retry states, and the work rail.
   */
  interface Artifact {
    kind: "html" | "image";
    html?: string;
    path?: string;
    pending?: boolean;
  }

  interface Props {
    artifact: Artifact;
    /** The conversation the artifact belongs to. Image artifacts resolve
     *  their file through it; an HTML artifact rendered outside a
     *  conversation (a pane, a task page) has none. */
    tabId?: string;
    /** The `artifact` work this render was persisted as. When set, the frame
     *  carries a rail naming it and opening it in a pane. */
    workRef?: { workId: string; title: string };
    /** Where the conversation lives, for the rail's Link control. */
    linkContext?: TaskLinkContext;
    /** Let a pane render use all available height while transcript and task
     *  renders continue to size themselves to their content. */
    fillAvailable?: boolean;
    skipMotion?: boolean;
    /** Bumping this re-creates the frame. The pane's Reload; a retry uses the
     *  same mechanism from inside. */
    reloadKey?: number;
  }

  let {
    artifact,
    tabId,
    workRef,
    linkContext,
    fillAvailable = false,
    skipMotion,
    reloadKey = 0,
  }: Props = $props();

  const session = getSurfaceContext();

  const imagePath = $derived(artifact.kind === "image" ? artifact.path : undefined);
  const isRaster = $derived(!!imagePath && isRasterImage(imagePath));
  const isSvg = $derived(!!imagePath && mediaTypeFor(imagePath)?.mime === "image/svg+xml");

  // An image on a tab's machine is read through that tab; a client with no
  // tabs (the cloud console) shows the HTML render alone.
  const imageRequest = $derived.by((): HostMediaRequest | null => {
    const workspace = session.workspace;
    const run = tabId && workspace ? workspace.runFor(tabId) : undefined;
    if (!imagePath || !tabId || !run || !workspace) return null;
    return { serverId: run.serverId, path: imagePath, ctx: workspace.ctxFor(tabId) };
  });
  const image = new HostMediaUrl(() => imageRequest);
  const artifactUrl = $derived(image.url ?? "");

  let renderError = $state<string | null>(null);
  const artifactError = $derived(
    image.hasFailed ? "This artifact image is unavailable." : renderError,
  );
  let retryAttempt = $state(0);

  // SVG renders through the frame (scripts contained, no host inlining): fetch
  // the file, then feed its text into the sandbox.
  let svgText = $state<string | null>(null);
  $effect(() => {
    if (!isSvg || !artifactUrl) return;
    let cancelled = false;
    svgText = null;
    fetch(artifactUrl)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("not found"))))
      .then((t) => {
        if (!cancelled) svgText = t;
      })
      .catch(() => {
        if (!cancelled) renderError = "This artifact image is unavailable.";
      });
    return () => {
      cancelled = true;
    };
  });

  // The markup the frame runs: an HTML artifact's own document, or the bytes of
  // an SVG file. Undefined while an SVG is still being fetched.
  const frameHtml = $derived.by(() => {
    if (artifact.kind === "html") return artifact.html ?? "";
    if (isSvg) return svgText ?? undefined;
    return undefined;
  });

  // An image retries with a freshly signed URL; an HTML render re-creates its frame.
  function retryArtifact() {
    renderError = null;
    svgText = null;
    retryAttempt += 1;
    if (imageRequest) void image.retry().catch(() => {});
  }

  let copiedImage = $state(false);

  function downloadHtml() {
    if (artifact.kind !== "html") return;
    downloadPayload(
      exportFileName(workRef?.title ?? "artifact", "html"),
      "text/html",
      { contents: artifact.html ?? "", encoding: "utf8" },
    );
  }

  async function copyImage() {
    if (!artifactUrl) return;
    try {
      const blob = await fetch(artifactUrl).then((r) => {
        if (!r.ok) throw new Error("Image not available");
        return r.blob();
      });
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      copiedImage = true;
      requestInputFocus();
      setTimeout(() => (copiedImage = false), 1500);
    } catch {}
  }
</script>

{#if artifact.pending}
  <ArtifactSkeleton {skipMotion} />
{:else}
  <div
    class="artifact-root {skipMotion ? '' : 'animate-msg-in-side'}"
    class:fill-available={fillAvailable}
  >
    {#if artifactError}
      <div
        class="flex min-h-28 flex-col items-center justify-center gap-3 rounded-2xl border border-(--solus-status-error)/20 bg-(--solus-status-error)/5 px-5 py-4 text-center text-sm text-(--solus-text-secondary)"
        role="alert"
        data-testid="artifact-error"
      >
        <span>{artifactError}</span>
        <div class="flex flex-wrap justify-center gap-2">
          {#if artifact.kind === "html" || imageRequest}
            <button
              type="button"
              class="min-h-10 rounded-lg border border-(--solus-container-border) bg-(--solus-container-bg) px-3.5 text-sm font-medium text-(--solus-text-primary)"
              onclick={retryArtifact}
            >
              Try again
            </button>
          {/if}
          {#if artifact.kind === "html"}
            <button
              type="button"
              class="min-h-10 rounded-lg border border-(--solus-container-border) bg-(--solus-container-bg) px-3.5 text-sm font-medium text-(--solus-text-primary)"
              onclick={downloadHtml}
            >
              Download HTML
            </button>
          {/if}
        </div>
      </div>
    {:else if isRaster && artifactUrl}
      <!-- The one render that is not HTML. It reuses the frame's chrome
           (expand, overlay, action cluster) rather than growing a second one. -->
      <SandboxFrame {fillAvailable} expandable={!fillAvailable && !workRef} reloadKey={retryAttempt + reloadKey}>
        <img
          class="artifact-img"
          src={artifactUrl}
          alt="Rendered artifact"
          data-testid="artifact-image"
          onerror={() => (renderError = "This artifact image is unavailable.")}
        />
        {#snippet actions()}
          {#if artifactUrl}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <button
                    {...tooltipProps}
                    class="artifact-action"
                    class:is-copied={copiedImage}
                    data-testid="artifact-copy-image"
                    onclick={copyImage}
                    aria-label="Copy image"
                  >
                    <span class="artifact-icon-swap">
                      <CopyIcon
                        size={14}
                        weight="bold"
                        class={copiedImage ? "icon-hidden" : ""}
                      />
                      <CheckIcon
                        size={14}
                        weight="bold"
                        class={copiedImage ? "" : "icon-hidden"}
                      />
                    </span>
                  </button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content
                value={copiedImage ? "Copied image" : "Copy image"}
              />
            </TooltipUI.Root>
          {/if}
        {/snippet}
      </SandboxFrame>
    {:else if frameHtml !== undefined}
      <SandboxFrame
        html={frameHtml}
        {fillAvailable}
        reloadKey={retryAttempt + reloadKey}
        lazy={!fillAvailable}
        expandable={!fillAvailable && !workRef}
        onError={() => (renderError = "This artifact could not be rendered.")}
      />
    {:else}
      <ContentSkeleton label="Loading artifact" preview />
    {/if}

    {#if workRef}
      <ArtifactRail workId={workRef.workId} title={workRef.title} {linkContext} />
    {/if}
  </div>
{/if}

<style>
  .artifact-root {
    padding-block: 0.5rem;
  }

  .artifact-root.fill-available {
    height: 100%;
    padding-block: 0;
  }

  .artifact-img {
    display: block;
    width: auto;
    max-width: 75%;
    max-height: clamp(12rem, 51svh, 31.5rem);
    height: auto;
    object-fit: contain;
    margin-inline: auto;
  }

  /* The frame is SandboxFrame's element, so the expanded state is read
     globally; only the image inside it is this component's to style. */
  :global(.artifact-frame.expanded) .artifact-img {
    width: 100%;
    height: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  @media (max-width: 40rem) {
    .artifact-img {
      max-height: min(45svh, 22.5rem);
    }
  }

  .artifact-icon-swap {
    position: relative;
    display: inline-flex;
    width: 0.875rem;
    height: 0.875rem;
    align-items: center;
    justify-content: center;
  }

  .artifact-icon-swap :global(svg) {
    position: absolute;
    transition:
      opacity 0.2s cubic-bezier(0.2, 0, 0, 1),
      transform 0.2s cubic-bezier(0.2, 0, 0, 1),
      filter 0.2s cubic-bezier(0.2, 0, 0, 1);
  }

  .artifact-icon-swap :global(svg.icon-hidden) {
    opacity: 0;
    transform: scale(0.25);
    filter: blur(0.25rem);
  }

  .artifact-icon-swap :global(svg:not(.icon-hidden)) {
    opacity: 1;
    transform: scale(1);
    filter: blur(0);
  }

  @media (prefers-reduced-motion: reduce) {
    .artifact-icon-swap :global(svg) {
      transition:
        opacity 0.16s ease,
        filter 0.16s ease;
      transform: none;
    }
  }
</style>
