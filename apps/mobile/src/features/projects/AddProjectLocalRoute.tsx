import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectLocalFolderScreen } from "./AddProjectScreen";

type AddProjectLocalRouteParams = {
  readonly environmentId?: string | string[];
  /** Solus: the codebase that gets the folder as a root. Without it, the folder becomes a project. */
  readonly codebaseId?: string | string[];
  /** Solus: the first folder of a new codebase. The chosen folder becomes its second folder. */
  readonly codebaseWith?: string | string[];
};

export function AddProjectLocalRoute({
  route,
}: StaticScreenProps<AddProjectLocalRouteParams | undefined>) {
  return <AddProjectLocalFolderScreen {...(route.params ?? {})} />;
}
