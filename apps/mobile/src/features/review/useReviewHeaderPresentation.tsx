import { useCheckoutGitControls } from "../../solus/CheckoutGit";
import type { ConversationController } from "@solus-mobile/features/conversation/conversation-controller";
import { useThreadGitMenuDefinition } from "../threads/ThreadGitControls";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReviewSectionItem } from "./reviewModel";
import type { AppBarMenuItem, AppBarMenu } from "../../components/ui/AppBar.types";
import type { AppSymbolName } from "../../components/ui/AppSymbol";

interface ReviewHeaderPresentation {
  readonly title: string;
  readonly subtitle: string;
  readonly gitMenu: AppBarMenu | null;
  readonly menuIcon: AppSymbolName;
  readonly refreshAction?: AppBarMenuItem;
}

export function useReviewHeaderPresentation(props: {
  readonly controller: ConversationController;
  readonly draftKey?: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly subtitle: string;
  readonly androidSubtitle: string;
  readonly selectedThreadCwd: string | null;
  readonly selectedSection: ReviewSectionItem | null;
  readonly onRefresh: () => Promise<void>;
}): ReviewHeaderPresentation {
  const controls = useCheckoutGitControls(
    props.controller,
    props.controller.run.workingDirectory,
    props.controller.canChooseStart,
  );
  const gitMenu = useThreadGitMenuDefinition({ ...controls, draftKey: props.draftKey });
  return {
    title: props.title,
    subtitle: props.subtitle,
    menuIcon: "ellipsis",
    gitMenu,
  };
}
