// Short, factual pointers to Solus features, shown near the bottom of the new
// tab home. Keep each to one sentence and true of the shipped product — a tip
// that names a control the reader cannot find reads as broken, not helpful.
export const SOLUS_TIPS: readonly string[] = [
  "Start a session in a git worktree to keep experimental work off your main branch.",
  "Switch a session between Claude and Codex from the model picker below the prompt.",
  "Open a split chat to run two conversations side by side.",
  "Use Plan mode to agree on an approach before the agent writes any code.",
  "Turn a prompt you repeat into an automation that runs on a schedule.",
  "Track work across sessions on the Tasks board.",
  "Ask the agent to make a Work — a document, slide deck, or diagram you can keep.",
  "Drop screenshots or files into the prompt to give the agent context.",
  "Change the project a session runs in from the chip below the prompt.",
  "Review the branch diff before you open a pull request.",
  "Summon the command palette to reach any action from the keyboard.",
  "Run the same session on another host by switching where it runs.",
];

/** Choose one tip at random. Called once per mount, so the tip stays stable for
 *  the life of the home rather than re-rolling on every render. */
export function pickRandomTip(): string {
  return SOLUS_TIPS[Math.floor(Math.random() * SOLUS_TIPS.length)];
}
