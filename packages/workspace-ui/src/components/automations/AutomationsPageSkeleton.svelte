<script lang="ts">
  import ListPageSkeleton from "../ui/list-page/ListPageSkeleton.svelte";
</script>

<!-- The automations page's own measures, stated once. It has no view switch and
     no refresh control, and its rows carry a wide name column — the same values
     the live page passes to ListSkeleton once it has loaded. -->
<ListPageSkeleton
  label="Loading automations"
  summaryCount={3}
  hasViewSwitcher={false}
  hasRefresh={false}
  hasPrimaryAction
  identWidth={110}
  plan={[[52, 38, 44, 30]]}
/>
