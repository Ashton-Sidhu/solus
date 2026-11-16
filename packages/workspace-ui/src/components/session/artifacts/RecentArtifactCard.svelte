<script lang="ts">
  import {
    LayoutTemplate as HtmlArtifactIcon,
    LayoutGrid as AppIcon,
    Image as ImageIcon,
    Pin as PinIcon,
  } from "@lucide/svelte";
  import {
    recentArtifactAccessibilityLabel,
    recentArtifactAge,
    recentArtifactTimeLabel,
    type RecentArtifact,
  } from "@solus/client-core/recent-artifacts";
  import { HostMediaUrl } from "../../../lib/host-media-url.svelte";
  import FileIcon from "../../ui/file-icon/FileIcon.svelte";
  import { artifactTitle, artifactTooltip } from "./lib/artifact-list";

  /**
   * One item of the Threads surface's row: a small picture of it, its name,
   * and how long ago it was last opened, changed, or added. A written work
   * shows the start of its text; an image shows itself; anything else shows
   * its icon. A pin marks a pinned work.
   */
  interface Props {
    item: RecentArtifact;
    /** The host that holds the session's files. */
    serverId: string;
    now: number;
    onOpen: () => void;
  }
  let { item, serverId, now, onOpen }: Props = $props();

  const artifact = $derived(item.owned.artifact);
  const title = $derived(artifactTitle(artifact));
  const age = $derived(recentArtifactAge(item, now));
  const image = new HostMediaUrl(() => (artifact.kind === "image" ? { serverId, path: artifact.path } : null));
</script>

<button
  type="button"
  class="group flex w-36 shrink-0 cursor-pointer flex-col gap-1.5 rounded-xl border-0 bg-transparent p-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium)"
  title={artifactTooltip(artifact)}
  aria-label={recentArtifactAccessibilityLabel(title, item, now)}
  data-testid="recent-artifact"
  data-kind={artifact.kind}
  onclick={onOpen}
>
  <span
    class="relative block h-22 w-full overflow-hidden rounded-xl bg-(--solus-tx-card-bg) shadow-[shadow:var(--solus-tx-card-shadow)] transition-shadow duration-(--duration-base) ease-(--ease-premium) group-hover:shadow-[0_0_0_1px_color-mix(in_oklch,var(--foreground)_14%,transparent)]"
  >
    {#if artifact.kind === "work" && artifact.workType !== "artifact"}
      <!-- The page itself, at a size that reads as a page: its title, then the start of its text. -->
      <span class="flex h-full flex-col gap-1 px-2.5 pt-2">
        <span class="line-clamp-1 text-[8px] leading-[1.3] font-semibold text-foreground">{title}</span>
        <span class="line-clamp-6 text-[6.5px] leading-[1.45] text-muted-foreground">{artifact.preview ?? ""}</span>
      </span>
    {:else if artifact.kind === "work"}
      <span class="flex h-full items-center justify-center bg-[color-mix(in_oklab,var(--solus-art-6)_12%,transparent)] text-[color-mix(in_oklab,var(--solus-art-6)_72%,var(--foreground))]">
        <HtmlArtifactIcon size={22} strokeWidth={1.5} />
      </span>
    {:else if artifact.kind === "image" && image.url}
      <img src={image.url} alt="" class="h-full w-full object-cover" loading="lazy" decoding="async" />
    {:else if artifact.kind === "image"}
      <span class="flex h-full items-center justify-center text-muted-foreground">
        <ImageIcon size={22} strokeWidth={1.5} />
      </span>
    {:else if artifact.kind === "app"}
      <span class="flex h-full items-center justify-center bg-[color-mix(in_oklab,var(--solus-art-7)_12%,transparent)] text-[color-mix(in_oklab,var(--solus-art-7)_72%,var(--foreground))]">
        <AppIcon size={22} strokeWidth={1.5} />
      </span>
    {:else if artifact.kind === "file"}
      <span class="flex h-full items-center justify-center">
        <FileIcon path={artifact.path} size={26} />
      </span>
    {/if}
    {#if item.pinned}
      <span
        class="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-md bg-foreground text-background"
        aria-hidden="true"
      >
        <PinIcon size={11} strokeWidth={2} />
      </span>
    {/if}
  </span>
  <span class="flex min-w-0 items-baseline gap-2 px-0.5">
    <span class="min-w-0 flex-1 truncate text-[13px] leading-[1.3] text-foreground">{title}</span>
    <span class="shrink-0 text-xs tabular-nums text-muted-foreground" title={recentArtifactTimeLabel(item, now)}>{age}</span>
  </span>
</button>
