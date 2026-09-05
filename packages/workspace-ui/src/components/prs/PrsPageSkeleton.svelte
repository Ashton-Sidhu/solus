<script lang="ts">
  import ListPageSkeleton from "../ui/list-page/ListPageSkeleton.svelte";
</script>

<!-- The pull request page's own loading state and measures, stated once. The
     page uses this for its data read in both Editor and Pill modes. -->
<ListPageSkeleton label="Loading pull requests" identWidth={44} hasViewSwitcher={false} toolbarFilters />
