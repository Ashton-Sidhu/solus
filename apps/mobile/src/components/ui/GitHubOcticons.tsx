import { githubOcticonPaths } from "@solus/client-core/github-octicons";
import type { IconProps } from "@tabler/icons-react-native/types";
import { forwardRef } from "react";
import Svg, { Path } from "react-native-svg";

function octicon(path: string) {
  return forwardRef<Svg, IconProps>(function GitHubOcticon(
    { size = 24, color = "currentColor", strokeWidth: _strokeWidth, ...props },
    ref,
  ) {
    return (
      <Svg ref={ref} width={size} height={size} viewBox="-1.6 -1.6 19.2 19.2" {...props}>
        <Path fill={color} d={path} />
      </Svg>
    );
  });
}

export const githubOcticons = {
  "git.issue": octicon(githubOcticonPaths.issueOpened),
  "git.issue.closed": octicon(githubOcticonPaths.issueClosed),
  "git.issue.skipped": octicon(githubOcticonPaths.issueSkipped),
  "arrow.triangle.pull": octicon(githubOcticonPaths.pullRequest),
  "git.pull-request.draft": octicon(githubOcticonPaths.pullRequestDraft),
  "git.pull-request.closed": octicon(githubOcticonPaths.pullRequestClosed),
  "git.pull-request.merged": octicon(githubOcticonPaths.pullRequestMerged),
};
