<script lang="ts">
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
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden="true"
>
  <rect x="3" y="3" width="18" height="18" rx="4" />
  <path d="m8 12.5 2.5 2.5L16 9" />
</svg>
