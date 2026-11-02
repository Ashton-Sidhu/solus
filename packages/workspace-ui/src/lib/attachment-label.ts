import type { Attachment } from "@solus/contracts/types";

const GENERATED_PASTED_IMAGE_NAME = /^pasted image(?: \d+)?\.[a-z0-9.+-]+$/i;
/**
 * The name `pastedTextFile` gives a large paste: a stamp the reader never chose.
 * The host stores it with `_` for each space, which is the name history reads.
 */
const GENERATED_PASTED_TEXT_NAME = /^pasted[ _]text[ _]\d{4}-\d{2}-\d{2}[ _]\d{6}(?:[ _]\d+)?\.txt$/i;

/** What a chip or card calls an attachment: its file name, unless Solus made the name up. */
export function attachmentLabel(attachment: Pick<Attachment, "type" | "name">): string {
  if (
    attachment.type === "image" &&
    GENERATED_PASTED_IMAGE_NAME.test(attachment.name)
  ) {
    return "Pasted image";
  }
  if (attachment.type === "file" && GENERATED_PASTED_TEXT_NAME.test(attachment.name)) {
    return "Pasted text";
  }

  return attachment.name;
}
