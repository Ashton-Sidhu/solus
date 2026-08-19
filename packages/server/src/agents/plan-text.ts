const HEADING_RE = /^#{1,2}\s+(.+)$/m

export function extractPlanTitle(planContent: string): string {
  const match = planContent.match(HEADING_RE)
  if (match) return match[1].trim().slice(0, 120)
  const firstLine = planContent.split(/\r?\n/).find((line) => line.trim().length > 0)
  return (firstLine ?? '').trim().slice(0, 60) || 'Untitled plan'
}
