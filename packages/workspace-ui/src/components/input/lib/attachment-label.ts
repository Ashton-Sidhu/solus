import type { Attachment } from "@solus/contracts/types";

const GENERATED_PASTED_IMAGE_NAME = /^pasted image(?: \d+)?\.[a-z0-9.+-]+$/i;

export function attachmentLabel(attachment: Attachment): string {
  if (
    attachment.type === "image" &&
    GENERATED_PASTED_IMAGE_NAME.test(attachment.name)
  ) {
    return "Pasted image";
  }

  return attachment.name;
}
