/** One part of a line of steps: the text between backticks is a command, which shows as code. */
export interface StepTextPart {
  text: string
  isCode: boolean
}

/** A line of steps in parts, so a command in backticks shows as code and not with its backticks. */
export function stepTextParts(text: string): StepTextPart[] {
  return text.split('`').map((part, index) => ({ text: part, isCode: index % 2 === 1 })).filter((part) => part.text)
}
