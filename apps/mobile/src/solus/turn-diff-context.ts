import { createContext } from "react";
import type { ReadTurnDiff } from "@solus/client-core/inline-review-guide";

export const TurnDiffReader = createContext<ReadTurnDiff | null>(null);
