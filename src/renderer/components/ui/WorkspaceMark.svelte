<script lang="ts">
  // The Solus corona — the repo favicon (favicon.svg) redrawn inline so it can
  // take its colour from the caller. Stands in for "My Workspace" wherever a
  // project icon would go.
  let { class: className = "" }: { class?: string } = $props();
</script>

<svg viewBox="0 0 32 32" fill="none" class={className} aria-hidden="true">
  <circle cx="16" cy="16" r="6.6" fill="currentColor" />
  <g stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
    <path d="M16,5 A11,11 0 0 1 27,16" />
    <path d="M25.24,23.48 A11,11 0 0 1 12.48,26.56" />
    <path d="M6.76,23.48 A11,11 0 0 1 5,12.48" />
  </g>
</svg>
