# Document outline

The collapsed rail shows at most twelve marks in a 9rem overview, with no
scrollbar. Long documents share marks across consecutive heading groups; all
headings, including the end of the document, remain represented. The active
heading highlights its group.

The full Contents list keeps every heading, scrolls independently, and is capped
at 24rem. Its header and shortcut hint stay visible. Where the full panel does
not fit beside the document, the header Contents control opens the list.

As the reader moves through the document, the outline brings the current heading
into view. It does not move the list while the pointer or keyboard focus is in
the outline, so the reader can choose another heading without interruption.

Desktop and web use the same side rail. Narrow panes use the Contents popover;
mobile uses the Outline sheet. These use the same heading list with a bounded
height and internal scrolling. The sheet renders the list directly without the
collapsed rail behind it. Heading navigation and comment counts are unchanged.

The outline belongs to the shared document shell, including documents opened from
Editor or Pill mode. It has no provider, host, or transport-specific behavior.
