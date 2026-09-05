<script lang="ts">
  import { Check as CheckIcon, Copy as CopyIcon } from "@lucide/svelte";
  import {
    getWindowContext,
    getWorkspaceContext,
    hostCapabilitiesStore,
    serversStore,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { hostPolicy } from "@solus/client-core/host-policy";
  import { unsupportedOnHost } from "@solus/client-core/host-capabilities";
  import {
    assetUrlCache,
    localArtifactProtocolUrl,
  } from "./lib/asset-url";
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

  const windowCtx = getWindowContext();
  const session = getWorkspaceContext();

  const RASTER_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];

  const ext = $derived(
    (artifact.path?.split(".").pop() ?? "").toLowerCase(),
  );
  const isRaster = $derived(
    artifact.kind === "image" && RASTER_EXTS.includes(ext),
  );
  const isSvg = $derived(artifact.kind === "image" && ext === "svg");

  let artifactUrl = $state("");
  let artifactError = $state<string | null>(null);
  let artifactRetryAvailable = $state(false);
  let retryAttempt = $state(0);
  $effect(() => {
    // A retry deliberately invalidates both local protocol and signed-URL
    // resolution without changing the artifact's durable identity.
    void retryAttempt;
    const path = artifact.kind === "image" ? artifact.path : undefined;
    const run = tabId ? session.runFor(tabId) : undefined;
    if (!path || !tabId || !run) {
      artifactUrl = "";
      artifactError = null;
      artifactRetryAvailable = artifact.kind === "html";
      return;
    }
    if (!windowCtx.isWeb && hostPolicy.isClientMachine(run.serverId)) {
      artifactUrl = localArtifactProtocolUrl(path);
      artifactError = null;
      artifactRetryAvailable = true;
      return;
    }

    const capabilities = hostCapabilitiesStore.for(run.serverId);
    if (capabilities === undefined) {
      artifactUrl = "";
      artifactError = null;
      artifactRetryAvailable = false;
      void hostCapabilitiesStore.load(run.serverId);
      return;
    }
    if (capabilities.assetUrls !== true) {
      const hostLabel =
        serversStore.hostFor(run.serverId)?.label ??
        serverConnections.connectionFor(run.serverId)?.target.label ??
        "this host";
      artifactUrl = "";
      artifactError = unsupportedOnHost("Artifact images", hostLabel);
      artifactRetryAvailable = false;
      return;
    }

    let cancelled = false;
    artifactUrl = "";
    artifactError = null;
    artifactRetryAvailable = true;
    void assetUrlCache
      .resolve({
        serverId: run.serverId,
        path,
        origin: serverConnections.httpOriginFor(run.serverId),
        api: session.apiFor(tabId),
        ctx: session.ctxFor(tabId),
      })
      .then((url) => {
        if (!cancelled) artifactUrl = url;
      })
      .catch(() => {
        if (!cancelled) artifactError = "This artifact image is unavailable.";
      });
    return () => {
      cancelled = true;
    };
  });

  // SVG renders through the frame (scripts contained, no host inlining): fetch
  // the file via the protocol, then feed its text into the sandbox.
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
        if (!cancelled) artifactError = "This artifact image is unavailable.";
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

  let copiedImage = $state(false);

  function retryArtifact() {
    artifactError = null;
    svgText = null;
    retryAttempt += 1;
  }

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
          {#if artifactRetryAvailable}
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
    {:else if isRaster && artifact.path}
      <!-- The one render that is not HTML. It reuses the frame's chrome
           (expand, overlay, action cluster) rather than growing a second one. -->
      <SandboxFrame {fillAvailable} reloadKey={retryAttempt + reloadKey}>
        <img
          class="artifact-img"
          src={artifactUrl}
          alt="Rendered artifact"
          data-testid="artifact-image"
          onerror={() => (artifactError = "This artifact image is unavailable.")}
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
        onExpandOnTouch={workRef && !fillAvailable
          ? () => session.openWork(workRef.workId, "focused")
          : undefined}
        onError={() => (artifactError = "This artifact could not be rendered.")}
      />
    {:else}
      <div class="artifact-loading" role="status" aria-label="Loading artifact">
        <div class="artifact-loading__bone"></div>
      </div>
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

  /* Brief hydration gap between the file landing and the frame painting —
     the same quiet bone as the skeleton's canvas block, not a spinner. */
  .artifact-loading {
    display: flex;
    min-height: 6rem;
  }

  .artifact-loading__bone {
    --sk-ink: 4%;
    flex: 1;
    border-radius: 0.5rem;
    background-image: linear-gradient(
      90deg,
      color-mix(in srgb, var(--solus-text-primary) var(--sk-ink), transparent) 0%,
      color-mix(in srgb, var(--solus-accent) 10%, transparent) 45%,
      color-mix(in srgb, var(--solus-text-primary) var(--sk-ink), transparent) 90%
    );
    background-size: 260% 100%;
    animation: artifact-loading-shim 2.4s linear infinite;
    box-shadow: inset 0 0 0 0.03125rem
      color-mix(in srgb, var(--solus-text-primary) 9%, transparent);
  }

  @keyframes artifact-loading-shim {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -100% 0;
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
    .artifact-loading__bone {
      animation: none;
      background-image: none;
      background-color: color-mix(
        in srgb,
        var(--solus-text-primary) var(--sk-ink),
        transparent
      );
    }
    .artifact-icon-swap :global(svg) {
      transition:
        opacity 0.16s ease,
        filter 0.16s ease;
      transform: none;
    }
  }
</style>
