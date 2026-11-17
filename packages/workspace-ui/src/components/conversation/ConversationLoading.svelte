<div class="relative h-full min-h-0" role="status" aria-label="Loading conversation">
  <span class="loading-label absolute inset-x-0 top-8 text-center text-xs text-(--solus-text-muted)">
    Loading conversation…
  </span>
</div>

<style>
  .loading-label {
    opacity: 0;
    animation: show-loading 0s 800ms forwards;
  }
  @keyframes show-loading {
    to { opacity: 1; }
  }
</style>
