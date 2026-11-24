<script lang="ts">
  import type { PersonHistoryEntry } from "@solus/contracts/person-history";
  import RecentArtifactsRow from "../session/artifacts/RecentArtifactsRow.svelte";
  import type { WorkspaceItem } from "./lib/workspace-items";
  import type { WorkspaceAppItem } from "./lib/workspace-apps";
  import { workspaceRecentItems, type WorkspaceRecentItem } from "./lib/workspace-recent";

  /**
   * The Workspace page's "Recently viewed" row (docs/workspace-page.md): the
   * works and apps the person opened last, from their history
   * (docs/plans/person-state.md). It shows nothing until they opened one.
   */
  interface Props {
    history: readonly PersonHistoryEntry[];
    works: readonly WorkspaceItem[];
    apps: readonly WorkspaceAppItem[];
    workHostOf: (workId: string) => string | null;
    machineIdOf: (serverId: string) => string;
    isDark: boolean;
    onOpenWork: (item: WorkspaceItem) => void;
    onOpenApp: (item: WorkspaceAppItem) => void;
  }
  let { history, works, apps, workHostOf, machineIdOf, isDark, onOpenWork, onOpenApp }: Props = $props();

  const items: WorkspaceRecentItem[] = $derived(workspaceRecentItems({ history, works, apps, workHostOf, machineIdOf }));
</script>

{#if items.length > 0}
  <div class="pt-1 pb-3">
    <RecentArtifactsRow
      {items}
      serverIdOf={(item) => item.serverId}
      {isDark}
      onOpen={(item) => (item.kind === "work" ? onOpenWork(item.work) : onOpenApp(item.app))}
    />
  </div>
{/if}
