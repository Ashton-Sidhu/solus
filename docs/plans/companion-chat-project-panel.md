# Project panel beside a companion chat

Opening a companion chat or draft keeps the primary conversation's project panel
open when the primary column has at least 600 CSS pixels. Below that width, the
panel hides to keep room for the conversation. Widening the column restores the
panel if the user's primary panel preference is open.

The primary panel continues to show the primary session or draft when focus moves
to the companion. A companion draft becoming a chat does not change this rule.
Other companion content retains its existing temporary collapse behavior.

The companion project panel starts at the top of its pane, beside the conversation
header and body. The header occupies only the conversation column, so the panel's
cards align with the primary project panel. Draft content stays centered below
its header; chat content keeps its composer at the bottom.

The pane loads both the draft composer and the conversation shell directly.
Sending a companion draft shows the conversation without an intermediate
route-loading skeleton. Loading saved conversation history can still show its
own loading state.

Desktop Editor mode and the wide web layout share this rule through WorkspaceBody.
Mobile's compact layout and desktop Pill mode do not display this project panel;
their existing navigation is unchanged. The rule is independent of the agent
provider and host connection.
