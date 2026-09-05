<script lang="ts">
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { browserOverlays } from "./lib/browser-overlays.svelte";
  import BrowserSkeleton from "./BrowserSkeleton.svelte";
  import { nativeSurfaces } from "./lib/native-surface-coordinator.svelte";
  import { stageDrag } from "./lib/stage-drag.svelte";
  import {
    BROWSER_BLANK_URL,
    browserProfilePartition,
  } from "@solus/contracts/browser-types";
  import { placeGuest } from "./lib/stage-math";
  import {
    browserGuest,
    shouldUseNativeBrowser,
    supportsNativeBrowser,
  } from "./lib/browser-guest";

  /**
   * The teleport layer: every native browser surface in the app, mounted once
   * at root and positioned over whichever pane is asking for it.
   *
   * This exists because an Electron `<webview>` cannot be moved. Reparenting
   * reloads the guest and `display: none` stops it rendering, so it can never
   * live inside a pane that PaneForge drags, a tab strip that hides its
   * siblings, or a route outlet that unmounts on navigation. The pane publishes
   * a rectangle; this layer paints into it.
   *
   * The layer sits below modals and the command palette in the same stacking
   * context as the rest of the app — the reason `<webview>` was chosen over
   * `WebContentsView`, which composites above the DOM entirely.
   */

  const canHostNatively = supportsNativeBrowser();

  // The surface handshake is one-way by nature: the host publishes whatever went
  // wrong as page state, and a host that dropped the connection has no one left
  // to answer. Left unhandled, a refused surface reaches the user as a renderer
  // error instead of as the pane's own message.
  const settled = (): void => {};
  // Only url pages have a native surface today; a device target is streamed
  // (P4), and a page owned by a remote host is driven there, not here.
  const eligibleNativeKeys = $derived(
    new Set(
      browserStore.entries.flatMap((entry) => {
        const key = browserStore.keyOf(entry.serverId, entry.page.browserPageId);
        return shouldUseNativeBrowser(
          canHostNatively,
          entry.serverId,
          serverConnections.localServerId(),
          entry.page.target.kind,
        )
          ? [key]
          : [];
      }),
    ),
  );

  // A hidden pane parks its guest but does not release the browser session.
  // Prune only pages that left the server-authoritative browser registry.
  $effect(() => nativeSurfaces.retain(eligibleNativeKeys));

  const nativePages = $derived(
    browserStore.entries.filter((entry) => {
      const key = browserStore.keyOf(entry.serverId, entry.page.browserPageId);
      return (
        nativeSurfaces.mountedKeys.has(key) &&
        shouldUseNativeBrowser(
          canHostNatively,
          entry.serverId,
          serverConnections.localServerId(),
          entry.page.target.kind,
        )
      );
    }),
  );

  /**
   * The guest's render process died. A `<webview>` cannot be reloaded from
   * that state, so recovery means mounting a new element — bounded, because a
   * page that crashes on load would otherwise re-create itself forever. Once
   * the budget is spent the host is told, so the pane says so instead of
   * showing an empty frame.
   */
  function guestCrashed(key: string): void {
    if (nativeSurfaces.recoverAfterCrash(key, Date.now()) === "retrying") return;
    void browserStore.detachSurface(key, "crashed").catch(settled);
  }
</script>

{#if nativePages.length}
    <!-- The generation is part of the key on purpose: a crashed guest is
         replaced by destroying the element and mounting a new one, which is the
         only recovery a dead render process has. The page itself lives on the
         server, so nothing but the element is lost. -->
    {#each nativePages as entry (`${entry.page.browserPageId}:${nativeSurfaces.generationOf(
      browserStore.keyOf(entry.serverId, entry.page.browserPageId),
    )}`)}
      {@const key = browserStore.keyOf(entry.serverId, entry.page.browserPageId)}
      {@const placement = placeGuest(
        entry.page.viewport,
        nativeSurfaces.rects.get(key),
      )}
      <!-- The positioned shell stays transparent and does not clip: the
           annotation pill is its sibling to the frame, and clipping here would
           cut the pill's rounded outline and shadow against a square white box.
           The inner frame alone clips the guest to the pane's slot. -->
      <div
        class="fixed"
        class:pointer-events-auto={placement.onScreen && !stageDrag.active}
        class:pointer-events-none={!placement.onScreen || stageDrag.active}
        style:left="{placement.left}px"
        style:top="{placement.top}px"
        style:width="{placement.width}px"
        style:height="{placement.height}px"
        style:z-index={placement.layer === "maximized" ? 10041 : 10}
      >
        <div
          class="absolute inset-0 overflow-hidden rounded-md bg-white shadow-sm"
        >
          <!-- `flex`, never `block`: a `<webview>` is a custom element wrapping an
               `<iframe>` in its shadow root, and Electron's own `display: flex`
               is the only thing making that iframe fill the tag. Overriding it
               drops the iframe to a replaced element's default 150px height, so
               the guest paints a thin band of the page and leaves the rest of the
               stage on the frame's white background. -->
          <webview
            src={BROWSER_BLANK_URL}
            partition={browserProfilePartition(
              entry.page.target.kind === "url"
                ? entry.page.target.projectRoot
                : undefined,
              entry.page.profileId,
            )}
            class="absolute top-0 left-0 flex origin-top-left"
            style:width="{entry.page.viewport.width}px"
            style:height="{entry.page.viewport.height}px"
            style:transform="scale({placement.scale})"
            use:browserGuest={{
              attach: (webContentsId) => {
                nativeSurfaces.attached(key);
                void browserStore.attachSurface(key, webContentsId).catch(settled);
              },
              detach: () => {
                if (nativeSurfaces.isReplacing(key)) return;
                void browserStore.detachSurface(key).catch(settled);
              },
              report: (report) => {
                nativeSurfaces.reported(key, report.loadState);
                void browserStore.reportSurface(key, report).catch(settled);
              },
              crashed: () => guestCrashed(key),
            }}
          ></webview>

          <!-- The load veil has to live here, above the guest, rather than in the
               stage: this layer is fixed at app root and paints over the pane, so
               anything the stage drew underneath would be hidden by the very blank
               guest it is explaining. Without it the first second of a page is an
               unexplained white rectangle, which is what "slow" actually felt
               like — the guest is mounted blank on purpose and has nothing to
               show until the host sends it somewhere. -->
          {#if placement.onScreen && !nativeSurfaces.hasPainted(key) && !entry.page.problem}
            <BrowserSkeleton label={entry.page.label} />
          {/if}
        </div>

        <!-- The pane's own chrome over its page — the annotation tools today.
             It has to be here for the same reason the veil does: this layer is
             fixed at app root and paints over the pane, so a bar the stage drew
             would sit behind the very page it is annotating. Bottom-centred and
             inside the frame, so it reads as belonging to the page rather than
             to the workspace. -->
        {#if placement.onScreen && browserOverlays.snippets.has(key)}
          {@const overlay = browserOverlays.snippets.get(key)}
          {@const blocksSurface = browserOverlays.blocking.has(key)}
          <!-- The annotation tools are click-through until a comment popup
               opens. That popup owns the full frame, because Electron can send
               hover input to the guest behind a child of a click-through layer. -->
          <div
            class="absolute inset-0 z-10"
            class:pointer-events-auto={blocksSurface}
            class:pointer-events-none={!blocksSurface}
          >
            {@render overlay?.(placement.scale)}
          </div>
        {/if}
      </div>
    {/each}
{/if}
