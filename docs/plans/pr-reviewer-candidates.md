# PR reviewer candidates

The request-reviewer dropdown loads all pages of GitHub repository collaborators
when opened. Search filters the complete loaded list by login, without case
sensitivity. The PR author and people already requested or reviewed are excluded.

The shared dropdown keeps search above a scrollable list. Matching rows remain
mounted for keyboard navigation. Desktop, web, and mobile use the same store and
host API. Loading or an API failure is shown instead of a partial candidate list.

The list height is capped at 17.5rem on desktop and touch devices, and 14rem on
precise-pointer laptop displays. Both caps shrink to fit the available viewport
space, with room reserved for the fixed search field. The menu is 15rem wide on
desktop and 13rem on laptops, and always fits within the viewport width. Type
uses the shared workspace chrome scale. Scrolling stays inside the result list.

The compact facts button aligns the menu at its start edge, so the menu opens
into the PR detail pane instead of over the neighboring PR list. The wide rail
row uses end alignment. Viewport collision handling remains enabled.
