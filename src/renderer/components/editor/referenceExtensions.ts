import type { AnyExtension } from "@tiptap/core";
import { PlanRefExtension } from "./planRefExtension";
import { WorkRefExtension } from "./workRefExtension";
import { PrRefExtension } from "./prRefExtension";
import { FileRefExtension } from "./fileRefExtension";
import { SlashRefExtension } from "./slashRefExtension";
import { SessionRefExtension } from "./sessionRefExtension";

// The six inline reference nodes (@file, #plan, %work, !PR, &session, /command)
// that the reference autocomplete inserts. Shared so any editor host — the
// lightweight MarkdownEditor or the rich DocumentEditor — registers the same
// node schema.
export const referenceExtensions: AnyExtension[] = [
  PlanRefExtension,
  WorkRefExtension,
  PrRefExtension,
  FileRefExtension,
  SlashRefExtension,
  SessionRefExtension,
];
