/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b
}

export class Counter {
  private total = 0
  /** Increments the counter. */
  increment(by: number): number {
    this.total = add(this.total, by)
    return this.total
  }
}
