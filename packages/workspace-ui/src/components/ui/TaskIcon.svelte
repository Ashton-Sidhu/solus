<script lang="ts">
  import type { SVGAttributes } from "svelte/elements";
  import { githubOcticonPaths } from "@solus/client-core/github-octicons";

  interface Props extends SVGAttributes<SVGSVGElement> {
    size?: number | string;
  }

  let { size = 14, class: className = "", ...attributes }: Props = $props();
</script>

<svg
  {...attributes}
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="-1.6 -1.6 19.2 19.2"
  fill="currentColor"
  class={className}
  aria-hidden="true"
>
  <path d={githubOcticonPaths.issueOpened} />
</svg>
