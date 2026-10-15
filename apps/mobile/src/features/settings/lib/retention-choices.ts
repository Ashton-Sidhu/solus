/** The day counts a phone offers for a retention setting. A value set on
 *  another client that is not one of them is offered too, so the selected
 *  row always shows what the host holds. */
const RETENTION_DAY_CHOICES = [1, 7, 30, 90]

export function retentionDayChoices(current: number): number[] {
  return RETENTION_DAY_CHOICES.includes(current)
    ? RETENTION_DAY_CHOICES
    : [...RETENTION_DAY_CHOICES, current].sort((a, b) => a - b)
}

export function retentionDaysLabel(days: number): string {
  return days === 1 ? '1 day' : `${days} days`
}
