import type { AnyExtension } from "@tiptap/core";
import { PlanRefExtension } from "./planRefExtension";
import { WorkRefExtension } from "./workRefExtension";
import { PrRefExtension } from "./prRefExtension";
import { FileRefExtension } from "./fileRefExtension";
import { SlashRefExtension } from "./slashRefExtension";
import { SessionRefExtension } from "./sessionRefExtension";

// The six inline reference nodes (@file, #plan, %work, !PR, &session, /command)
// that the rich DocumentEditor registers in its node schema. Lightweight
// CodeMirror composers render the canonical markdown tokens as decorations.
export const referenceExtensions: AnyExtension[] = [
  PlanRefExtension,
  WorkRefExtension,
  PrRefExtension,
  FileRefExtension,
  SlashRefExtension,
  SessionRefExtension,
];
