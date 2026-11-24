<script module lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { installChipSelection } from "../../lib/chip-selection";

  const failedFaviconUrls = new SvelteSet<string>();
  installChipSelection();
</script>

<script lang="ts">
  import Icon from "@iconify/svelte";
  import { webLinkIcon } from "@solus/client-core/web-link-icon";
  import { fileDrag } from "../../lib/file-drag";
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { Globe as GlobeIcon, MessageCircleMore as ChatCircleDotsIcon, FileText as FileTextIcon, Server as ServerIcon, Workflow as WorkflowIcon } from "@lucide/svelte";
  import { GitPullRequestIcon, IssueOpenedIcon } from "../ui/octicons";
  import { getClientShellContext, getSurfaceContext } from "../../contexts";
  import { filePreviewMediaKind, parseFileHref, requestFilePreview } from "../../lib/filePreview";
  import { routeForHref } from "../../lib/agent-links";
  import { hoverIntent } from "../../lib/hover-intent";
  import FileIcon from "../ui/file-icon/FileIcon.svelte";
  import { tokenClassName } from "../editor/tokenStyle";
  import { codeFileLinkLabel } from "./lib/assistant-markdown";
  import { fileLinkCopyParts, linkChipCopyParts, linkReference } from "./lib/markdown-text";
  import { fileReferenceText } from "../editor/reference-tokens";
  import { fileLinkTooltip } from "./lib/file-link-path";
  import { assetUrlCache } from "../artifact/lib/asset-url";
  import { getMarkdownImageContext, markdownAssetId } from "./lib/markdown-image";
  import { parseSessionHref } from "@solus/contracts/session-link";
  import { parseHostHref } from "@solus/contracts/host-link";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import { isManagedHost } from "../servers/lib/managed-host";
  import { resolveSessionLinkMeta } from "./lib/session-link";
  import { getSessionLinkContext } from "./lib/session-link-context";
  import type { Snippet } from "svelte";
  import { checkoutPlace } from "../../contexts/workspace/run-location";

  interface Props {
    href?: string;
    title?: string;
    text?: string;
    /** An image embed keeps file-chip styling for web URLs and stored assets too. */
    fileChip?: boolean;
    children?: Snippet;
  }
  let { href = "", title = undefined, text = undefined, children, fileChip = false }: Props = $props();

  type Status = "pending" | "accepted" | "rejected";

  const VARIANT_FOR = {
    pending: "plan-pending",
    accepted: "plan-accepted",
    rejected: "plan-rejected",
  } satisfies Record<Status, "plan-pending" | "plan-accepted" | "plan-rejected">;

  // A link to a plan, a session, or a file opens in the workspace; a client
  // with none (the cloud console) opens a work or a task at its own page and
  // shows the rest as text.
  const session = getSurfaceContext().workspace;
  const shell = getClientShellContext();
  const sessionLinkContext = getSessionLinkContext();
  const assetContext = getMarkdownImageContext();

  const isPlanRef = $derived(href.startsWith("plan://"));
  const isWorkRef = $derived(href.startsWith("work://"));
  const isPrRef = $derived(href.startsWith("pr://"));
  const isTaskRef = $derived(href.startsWith("task://"));
  const isAutomationRef = $derived(href.startsWith("automation://"));
  // What a paste into a composer restores this chip from (`reference-clipboard.ts`).
  const reference = $derived(linkReference(text ?? "", href));
  const sessionParams = $derived(parseSessionHref(href));
  // A host chip (docs/plans/host-fleet.md D12). It opens the host's page when
  // the host is one of this client's; a reader with no such host sees what the
  // link says of it.
  // An image embed copies as the image it is.
  const copyParts = $derived(linkChipCopyParts(href, fileChip));
  const hostRef = $derived(parseHostHref(href, text ?? ""));
  // The link names the host by the identity every client knows. A host of this
  // client shows the name and the mark this client has for it now.
  const knownHost = $derived(
    hostRef ? (serversStore.servers.find((server) => server.id === serverConnections.resolveId(hostRef.serverId)) ?? null) : null,
  );
  const hostSystem = $derived(knownHost?.os ?? hostRef?.system);
  const isManagedHostRef = $derived(isManagedHost(knownHost?.uplink));
  const hostFacts = $derived(
    hostRef ? [knownHost ? null : "Not one of your hosts", hostRef.route, hostRef.address, hostRef.state].filter(Boolean).join(" · ") : undefined,
  );
  const fileRef = $derived(parseFileHref(href));
  const assetId = $derived(markdownAssetId(href));
  let assetHref = $state("");

  $effect(() => {
    const currentAssetId = assetId;
    const serverId = assetContext?.serverId();
    const api = assetContext?.api();
    if (!currentAssetId || !serverId || !api || filePreviewMediaKind(href)) {
      assetHref = "";
      return;
    }
    let cancelled = false;
    void assetUrlCache.resolve({
      serverId,
      assetId: currentAssetId,
      name: text,
      origin: serverConnections.httpOriginFor(serverId),
      api,
      ctx: assetContext?.ctx(),
    }).then((url) => {
      if (!cancelled) assetHref = url;
    }).catch(() => {
      if (!cancelled) assetHref = "";
    });
    return () => {
      cancelled = true;
    };
  });
  const codeFileLabel = $derived(codeFileLinkLabel(text, fileRef?.line));
  // A file link copies as its path; a paste into a composer restores the mention.
  const fileCopyParts = $derived(
    fileRef && !fileChip
      ? fileLinkCopyParts(fileRef.path, fileRef.line, `${codeFileLabel ?? text ?? ""}${fileRef.line ? `:${fileRef.line}` : ""}`)
      : null,
  );
  const fileReference = $derived(
    fileRef && !fileChip ? fileReferenceText(fileRef.line ? `${fileRef.path}:${fileRef.line}` : fileRef.path) : undefined,
  );
  // The same tab a click would preview against, so the tooltip names the
  // directory the link would actually open in.
  const fileLinkWorkingDirectory = $derived(
    checkoutPlace(session?.sessionFor(session.focusedChatTabId ?? session.activeTabId)?.run)?.path,
  );
  // The destination comes from the codec; only the chip's own decoration is
  // read off the href here, and a plan's approval status is the whole of it.
  const linkRoute = $derived(
    routeForHref(href, { title, serverId: sessionLinkContext?.serverId() }),
  );
  // A GitHub link carries the page to fall back to; a `pr://` link has none.
  const prSourceUrl = $derived(
    linkRoute?.name === "prReview" && /^https:\/\//i.test(href) ? href : undefined,
  );
  const warmPrLink = $derived(
    session && linkRoute?.name === "prReview"
      ? hoverIntent(() => session.warmRoute(linkRoute, { sourceUrl: prSourceUrl }))
      : undefined,
  );
  const planStatus = $derived.by<Status>(() => {
    try {
      const status = new URL(href).searchParams.get("status");
      return status === "accepted" || status === "rejected" ? status : "pending";
    } catch {
      return "pending";
    }
  });

  const webIcon = $derived(webLinkIcon(href));
  const faviconUrl = $derived(webIcon?.kind === "favicon" ? webIcon.url : null);

  function openHost() {
    if (!session || !knownHost) return;
    connectionsNav.open(knownHost.id);
    session.showSettings("api-access", "click");
  }

  function handleClick(e: MouseEvent) {
    const mediaKind = filePreviewMediaKind(fileRef?.path ?? href) ?? (fileChip ? "image" : null);
    if (mediaKind && session) {
      e.preventDefault();
      requestFilePreview({
        path: fileRef?.path ?? href,
        mediaKind,
        tabId: session.focusedChatTabId ?? session.activeTabId,
        source: { serverId: assetContext?.serverId(), cwd: assetContext?.cwd(), ctx: assetContext?.ctx() },
      });
    } else if (assetId) {
      e.preventDefault();
      if (assetHref) localApi.openExternal(assetHref);
    } else if (linkRoute) {
      e.preventDefault();
      if (session) {
        session.openRoute(linkRoute, { sourceUrl: prSourceUrl });
      } else if (linkRoute.name === "work") {
        shell.openResource({ kind: "work", workId: linkRoute.params.workId, serverId: linkRoute.params.serverId });
      } else if (linkRoute.name === "task") {
        shell.openResource({ kind: "task", taskId: linkRoute.params.taskId, serverId: linkRoute.params.serverId });
      }
    } else if (sessionParams) {
      e.preventDefault();
      if (!session) return;
      void resolveSessionLinkMeta(sessionParams, sessionLinkContext?.serverId()).then((meta) =>
        session.opening.resumeSession(meta),
      );
    } else if (fileRef) {
      e.preventDefault();
      if (!session) return;
      requestFilePreview({
        ...fileRef,
        tabId: session.focusedChatTabId ?? session.activeTabId,
      });
    } else if (href) {
      e.preventDefault();
      localApi.openExternal(href);
    }
  }
</script>

<!-- A chip copies as what it reads as: its label, or a file's path. Its
     reference rides along in the copied HTML (`data-solus-reference`). -->
{#snippet copyOpen()}<span class="solus-token__copy-only">{copyParts.open}</span>{/snippet}
{#snippet copyClose()}<span class="solus-token__copy-only">{copyParts.close}</span>{/snippet}
{#snippet fileLabel()}{#if codeFileLabel !== null}{codeFileLabel}{:else}{@render children?.()}{/if}{#if fileRef?.line}<span class="solus-token__line-number">:{fileRef.line}</span>{/if}{/snippet}

{#if isPlanRef && linkRoute}
  <button
    type="button"
    onclick={handleClick}
    class={tokenClassName(VARIANT_FOR[planStatus])}
    data-solus-reference={reference}
  ><span class="solus-token__icon">
      {#if planStatus === "accepted"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      {:else if planStatus === "rejected"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>
      {/if}
</span><span>{@render children?.()}</span>
  </button>
{:else if isWorkRef && linkRoute}
  <button
    type="button"
    onclick={handleClick}
    class={tokenClassName('work')}
    data-solus-reference={reference}
  ><span class="solus-token__icon">
      <FileTextIcon size={12} />
</span><span>{@render children?.()}</span>
  </button>
{:else if isPrRef && linkRoute}
  <button
    type="button"
    onclick={handleClick}
    {@attach warmPrLink}
    class={tokenClassName('pr')}
    data-solus-reference={reference}
  ><span class="solus-token__icon">
      <GitPullRequestIcon size={12} />
</span><span>{@render children?.()}</span>
  </button>
{:else if sessionParams}
  <button
    type="button"
    onclick={handleClick}
    class={tokenClassName('session')}
    data-solus-reference={reference}
  ><span class="solus-token__icon">
      <ChatCircleDotsIcon size={12} />
</span><span>{@render children?.()}</span>
  </button>
{:else if (isTaskRef || isAutomationRef) && linkRoute}
  <button
    type="button"
    onclick={handleClick}
    class={tokenClassName(isTaskRef ? 'task' : 'automation')}
    data-solus-reference={reference}
  ><span class="solus-token__icon">
      {#if isTaskRef}<IssueOpenedIcon size={12} />{:else}<WorkflowIcon size={12} />{/if}
</span><span>{@render children?.()}</span>
  </button>
{:else if hostRef}
  {#snippet hostChip()}
    <span class="solus-token__icon">
      {#if hostSystem || isManagedHostRef}
        <HostOperatingSystemIcon os={hostSystem} managed={isManagedHostRef} size={12} />
      {:else}
        <ServerIcon size={12} />
      {/if}
</span><span>{#if knownHost}{knownHost.label}{:else}{@render children?.()}{/if}</span>
  {/snippet}
  {#if session && knownHost}
    <button type="button" onclick={openHost} title={hostFacts} class={tokenClassName('host')} data-solus-reference={reference}>{@render hostChip()}</button>
  {:else}
    <span title={hostFacts} class={tokenClassName('host')} data-solus-reference={reference}>{@render hostChip()}</span>
  {/if}
{:else if fileRef || fileChip}
  <button
    type="button"
    class={tokenClassName("file")}
    use:fileDrag={() => {
      const serverId = assetContext?.serverId();
      return serverId && fileRef
        ? { serverId, path: fileRef.path, ctx: assetContext?.ctx() }
        : null;
    }}
    data-solus-reference={fileReference}
    title={fileRef ? fileLinkTooltip(fileRef.path, fileRef.line, fileLinkWorkingDirectory) : title ?? href}
    onclick={handleClick}
  ><span class="solus-token__icon">
      <!-- Only trusted package SVG and static local symbols enter this markup. -->
      <FileIcon path={fileRef?.path ?? text ?? href} size={12} />
</span><span>{#if fileCopyParts}<span class="solus-token__copy-only">{fileCopyParts.open}</span><span class={fileCopyParts.isLabelCopied ? undefined : "solus-token__shown-only"}>{@render fileLabel()}</span><span class="solus-token__copy-only">{fileCopyParts.close}</span>{:else}{@render copyOpen()}{@render fileLabel()}{@render copyClose()}{/if}</span>
  </button>
{:else}
  {#snippet linkContents()}
    {#if webIcon}<span class="mr-[0.3em] inline-flex size-[0.85em] items-center justify-center align-[-0.125em] text-(--solus-text-primary) [&>svg]:block [&>svg]:size-full" aria-hidden="true">
      {#if webIcon.kind === "github"}
        <Icon icon="simple-icons:github" width="100%" height="100%" />
      {:else if faviconUrl && !failedFaviconUrls.has(faviconUrl)}
        <img
          class="block size-full rounded-sm object-contain"
          src={faviconUrl}
          alt=""
          width="12"
          height="12"
          loading="lazy"
          referrerpolicy="no-referrer"
          onerror={(event) => failedFaviconUrls.add(event.currentTarget.src)}
        />
      {:else}
        <GlobeIcon size="100%" />
      {/if}
    </span>{/if}{@render children?.()}
  {/snippet}
  <a href={assetId ? assetHref || undefined : href} {title} class="solus-link mx-[0.15em]" onclick={handleClick} {@attach warmPrLink}>
    {@render linkContents()}
  </a>
{/if}
