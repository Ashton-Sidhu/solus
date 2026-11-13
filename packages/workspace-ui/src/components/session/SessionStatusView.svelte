<script lang="ts">
  import SidebarList, { type SidebarListShared } from "./SidebarList.svelte";
  import { buildSidebarListItems, type SidebarListInput } from "./lib/sidebar-list-items";

  /** The sidebar's status view: the sessions bare, then Shared with you, the
   *  Pinned and Working sections, and the shelves (docs/plans/sidebar-project-view.md). */
  interface Props {
    input: SidebarListInput;
    list: SidebarListShared;
  }
  let { input, list }: Props = $props();

  /** Drafts, the sessions, the Pinned and Working sections, and both shelves as one list,
   *  so every change between them animates as a change of order
   *  (docs/plans/sidebar-motion.md). */
  const items = $derived(buildSidebarListItems(input));
</script>

<SidebarList {...list} {items} />
