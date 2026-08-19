<script lang="ts">
  import ListPageSkeleton from "../ui/list-page/ListPageSkeleton.svelte";
</script>

<!-- The pull request page's own measures, stated once. Both shells that can
     mount the page lazily — the pane outlet and the pill body — draw this, so
     the geometry lives here rather than being repeated at each call site. -->
<ListPageSkeleton label="Loading pull requests" identWidth={44} />
