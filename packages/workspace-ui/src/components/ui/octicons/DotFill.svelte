<script lang="ts">
  import type { LucideProps } from "@lucide/svelte";
  import Octicon from "./Octicon.svelte";

  let props: LucideProps = $props();
</script>

<!-- Octicon `dot-fill`. -->
<Octicon {...props} path="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" />
