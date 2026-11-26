<script lang="ts">
  import ListPageSkeleton from "../ui/list-page/ListPageSkeleton.svelte";
</script>

<!-- The tasks page's own measures, stated once. Tasks leads with a New task
     button, which pull requests has no equivalent of — drawing the cluster
     wrong is the reflow this exists to prevent. -->
<ListPageSkeleton
  page="tasks"
  label="Loading issues"
  hasPrimaryAction
  hasViewSwitcher={false}
  identWidth={62}
/>
