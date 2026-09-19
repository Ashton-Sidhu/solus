<script lang="ts">
  import {
    ExternalLink as ExternalLinkIcon,
    FileText as FileTextIcon,
    MessageSquare as MessageSquareIcon,
    SquareCheck as SquareCheckIcon,
  } from "@lucide/svelte";
  import { pageRouteFragment } from "../lib/page-routes";

  /**
   * The page shell's rail (docs/plans/cloud-service-model.md): one organization's
   * three lists and the way to the workspace. A side rail where the window is wide,
   * a strip under the band on a phone — the same four destinations either way.
   */
  interface Props {
    organizationId: string;
    organizationName: string;
    section: "tasks" | "works" | "sessions";
    variant: "side" | "strip";
    onOpenWorkspace: () => void;
  }
  let { organizationId, organizationName, section, variant, onOpenWorkspace }: Props = $props();

  const entries = $derived([
    { key: "tasks" as const, label: "Tasks", icon: SquareCheckIcon, href: pageRouteFragment({ organizationId, page: "tasks" }) },
    { key: "works" as const, label: "Works", icon: FileTextIcon, href: pageRouteFragment({ organizationId, page: "works" }) },
    { key: "sessions" as const, label: "Sessions", icon: MessageSquareIcon, href: pageRouteFragment({ organizationId, page: "sessions" }) },
  ]);
</script>

{#if variant === "side"}
  <aside class="flex h-full w-[15rem] shrink-0 flex-col gap-4 overflow-y-auto border-l border-(--hairline) bg-(--solus-rail-bg) px-3 py-4" aria-label="{organizationName} workspace" data-testid="page-rail">
    <h2 class="px-1.5 text-[0.8125em] font-medium tracking-[0.06em] text-muted-foreground uppercase">{organizationName}</h2>
    <nav class="flex flex-col gap-0.5">
      {#each entries as entry (entry.key)}
        <a
          href={entry.href}
          class="flex min-h-9 items-center gap-2 overflow-hidden rounded-lg px-2 text-(--solus-text-primary) transition-[background] duration-150 hover:bg-(--solus-surface-hover) pointer-coarse:min-h-11 {section === entry.key ? 'bg-(--solus-surface-hover) font-medium' : ''}"
          aria-current={section === entry.key ? "page" : undefined}
          data-testid="page-rail-{entry.key}"
        >
          <entry.icon size={14} class="shrink-0 text-muted-foreground" />
          <span class="truncate">{entry.label}</span>
        </a>
      {/each}
    </nav>
    <button
      type="button"
      class="mt-auto flex min-h-9 cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 text-left text-(--solus-text-secondary) transition-[background,color] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) pointer-coarse:min-h-11"
      onclick={onOpenWorkspace}
      data-testid="page-rail-workspace"
    >
      <ExternalLinkIcon size={14} class="shrink-0 text-muted-foreground" />
      <span class="truncate">Open workspace</span>
    </button>
  </aside>
{:else}
  <nav class="flex h-11 shrink-0 items-stretch gap-1 border-b border-(--hairline) bg-(--solus-rail-bg) px-2 pointer-coarse:h-12" aria-label="{organizationName} workspace" data-testid="page-strip">
    {#each entries as entry (entry.key)}
      <a
        href={entry.href}
        class="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-(--solus-text-secondary) {section === entry.key ? 'font-medium text-(--solus-text-primary)' : ''}"
        aria-current={section === entry.key ? "page" : undefined}
      >
        <entry.icon size={14} class="shrink-0" />
        <span class="truncate">{entry.label}</span>
      </a>
    {/each}
    <button type="button" class="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-(--solus-text-secondary)" onclick={onOpenWorkspace} title="Open workspace" aria-label="Open workspace">
      <ExternalLinkIcon size={14} />
    </button>
  </nav>
{/if}
