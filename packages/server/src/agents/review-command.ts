/** Both backends also advertise the bundled skill under its own name — Codex as
 *  `solus-review`, Claude as the plugin-namespaced `solus:solus-review`. Typing
 *  either reaches the skill with no host mode and no target, which the skill
 *  forbids, so the command list offers only the `/review:*` aliases. */
export function isRawReviewSkill(command: { name: string }): boolean {
  return /^(?:[a-z0-9-]+:)?solus-review$/i.test(command.name)
}
