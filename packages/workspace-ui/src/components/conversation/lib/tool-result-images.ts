import type { ToolResultImage } from "@solus/contracts/types";

/** The frame's shape before the picture loads, so the transcript does not
 *  jump when it arrives. A host that could not read the size gets 4:3. */
export function toolImageAspectRatio(image: ToolResultImage): string {
  return image.width && image.height ? `${image.width} / ${image.height}` : "4 / 3";
}
