<script lang="ts">
  import type { LucideProps } from "@lucide/svelte";

  let {
    path,
    size = 24,
    class: className = "",
    color: _color,
    strokeWidth: _strokeWidth,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    nonScalingStroke: _nonScalingStroke,
    children: _children,
    ...rest
  }: LucideProps & { path: string } = $props();
</script>

<!-- A filled GitHub Octicon (MIT), drawn so it can stand in for a Lucide icon.
     Octicons fill their 16-unit canvas edge to edge, while Lucide keeps its
     drawing inside a 20-of-24 optical box. Padding the canvas to 16 × 24/20
     keeps `size` meaning the same thing for both, so the two sit on one row. -->
<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="-1.6 -1.6 19.2 19.2"
  fill="currentColor"
  class={className}
  focusable="false"
  {...rest}
>
  <path d={path} />
</svg>
