<script lang="ts">
  let { src, title }: { src: string; title: string } = $props();
  let failed = $state(false);
</script>

<div class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4" data-testid="image-file-preview">
  {#if failed}
    <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">
      This image could not be displayed. The file may be damaged or use an unsupported format.
    </p>
  {:else}
    <img
      {src}
      alt={title}
      class="max-h-full max-w-full object-contain"
      onerror={() => (failed = true)}
    />
  {/if}
</div>
