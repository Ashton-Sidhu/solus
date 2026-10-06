<script lang="ts">
  import type { ToolResultImage } from "@solus/contracts/types";
  import MarkdownImage from "./MarkdownImage.svelte";
  import { toolImageAspectRatio } from "./lib/tool-result-images";

  /**
   * The pictures a tool call returned, under its step. The transcript carries
   * only asset ids; each picture loads from the host asset store through a
   * signed URL once its step is open, in a frame sized from the stored pixel
   * size. A click opens it at full size.
   */
  interface Props {
    images: ToolResultImage[];
    label: string;
  }

  let { images, label }: Props = $props();
</script>

<div class="flex flex-wrap gap-2 pb-1.5 pl-8">
  {#each images as image, index (index)}
    <div
      class="h-60 max-w-full overflow-hidden rounded-lg bg-muted [&_button]:h-full [&_button]:w-full [&_img]:h-full [&_img]:w-full [&_img]:object-contain"
      style:aspect-ratio={toolImageAspectRatio(image)}
    >
      <MarkdownImage
        href={`asset://${image.assetId}`}
        text={images.length > 1 ? `${label} (${index + 1} of ${images.length})` : label}
        expandable
      />
    </div>
  {/each}
</div>
