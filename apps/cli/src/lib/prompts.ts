import { createInterface, type Interface } from 'node:readline/promises'

/**
 * The questions `solus setup` asks in a terminal (plans/009-organization-vms.md
 * §5): one at a time, numbered choices, Enter for the default. Setup itself never
 * asks without a terminal; `isInteractive` is how it knows.
 */
export interface Choice<T extends string> {
  value: T
  label: string
  hint?: string
}

export interface Prompter {
  choose<T extends string>(question: string, choices: Array<Choice<T>>, fallback: T): Promise<T>
  close(): void
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

export function terminalPrompter(): Prompter {
  let readline: Interface | null = null
  const open = () => readline ??= createInterface({ input: process.stdin, output: process.stdout })
  return {
    async choose(question, choices, fallback) {
      const lines = choices.map((choice, index) => `  ${index + 1}. ${choice.label}${choice.hint ? `\n     ${choice.hint}` : ''}`)
      const defaultIndex = Math.max(0, choices.findIndex((choice) => choice.value === fallback)) + 1
      for (;;) {
        const answer = (await open().question(`\n${question}\n${lines.join('\n')}\nChoose [${defaultIndex}]: `)).trim()
        if (!answer) return fallback
        const picked = choices[Number(answer) - 1]
        if (picked && /^\d+$/.test(answer)) return picked.value
        process.stdout.write(`Type a number from 1 to ${choices.length}.\n`)
      }
    },
    close() {
      readline?.close()
      readline = null
    },
  }
}
