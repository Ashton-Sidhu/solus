<script lang="ts">
  import { FileTextIcon, GraphIcon, PresentationIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { formatTimeAgo } from "../../lib/sessionUtils";
  import type { SessionWork } from "./lib/session-works";

  interface Props {
    items: SessionWork[];
  }
  let { items }: Props = $props();

  const session = getWorkspaceContext();

  function open(item: SessionWork) {
    void session.openWorkModal(item.work.id, item.work.title, { secondary: true });
    requestInputFocus();
  }
</script>

<ul class="m-0 flex list-none flex-col gap-0.5 p-0">
  {#each items as item (item.work.id)}
    <li>
      <button
        type="button"
        class="group flex min-h-[2rem] w-full cursor-pointer items-center gap-2 rounded-[0.4375rem] border-none bg-transparent px-2 py-[0.3125rem] text-left text-(--solus-text-primary) transition-colors duration-150 hover:bg-(--solus-surface-hover) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
        onclick={() => open(item)}
      >
        <span
          class="inline-flex shrink-0 text-(--solus-text-tertiary) transition-colors duration-150 group-hover:text-(--solus-accent)"
          aria-hidden="true"
        >
          {#if item.work.type === "diagram"}
            <GraphIcon
              size={13}
              class="text-[color-mix(in_srgb,var(--project-icon-blue)_78%,var(--solus-text-tertiary))] group-hover:text-(--project-icon-blue)"
            />
          {:else if item.work.type === "slides"}
            <PresentationIcon
              size={13}
              class="text-[color-mix(in_srgb,var(--project-icon-blue)_78%,var(--solus-text-tertiary))] group-hover:text-(--project-icon-blue)"
            />
          {:else}
            <FileTextIcon
              size={13}
              class="text-[color-mix(in_srgb,var(--project-icon-blue)_82%,var(--solus-text-tertiary))] group-hover:text-(--project-icon-blue)"
            />
          {/if}
        </span>
        <span
          class="min-w-0 flex-1 truncate text-[0.8125rem] font-normal text-(--solus-text-secondary) transition-colors duration-150 group-hover:text-(--solus-text-primary)"
        >
          {item.work.title || "Untitled"}
        </span>
        <!-- One quiet trailing word: created (accent) vs updated (muted); the
             exact time lives on the tooltip. -->
        <span
          class="shrink-0 text-[0.6875rem] {item.action === 'created'
            ? 'text-(--solus-accent)'
            : 'text-(--solus-text-tertiary)'}"
          title="{item.action === 'created'
            ? 'Created'
            : 'Updated'} {formatTimeAgo(item.work.updatedAt)}"
        >
          {item.action === "created" ? "Created" : "Updated"}
        </span>
      </button>
    </li>
  {/each}
</ul>
