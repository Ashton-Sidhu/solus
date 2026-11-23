<script lang="ts">
  import type { LucideProps } from "@lucide/svelte";
  import { githubOcticonPaths } from "@solus/client-core/github-octicons";
  import Octicon from "./Octicon.svelte";

  let props: LucideProps = $props();
</script>

<Octicon aria-hidden="true" {...props} path={githubOcticonPaths.pullRequestClosed} />
