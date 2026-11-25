<script lang="ts">
  // Auto-merge as one glyph: the merge mark with a clock, "merge when ready".
  // Drawn in Lucide's grid and stroke so it sits beside the Lucide icons of
  // the pull request row.
  interface Props {
    size?: number;
    class?: string;
  }
  let { size = 14, class: className = "" }: Props = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden="true"
>
  <circle cx="6" cy="6" r="3" />
  <path d="M6 21V9a9 9 0 0 0 6 8.5" />
  <circle cx="18" cy="17" r="5" />
  <path d="M18 15v2l1.2 1" />
</svg>
