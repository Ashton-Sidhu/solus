/**
 * The held value when a host sends an equal one again, else the new value: a
 * reader that compares by identity then sees only real changes. Two values
 * are equal when their JSON is the same, which is what the host sent; a value
 * that serializes in another key order counts as changed, which costs only a
 * render. Use it once per answer at the store that keeps a bounded answer (a
 * host fact, a project, a pull request), never on each render, and never on a
 * transcript or another stream without a bound.
 */
export function keepEqual<T>(next: T, held: T): T {
  return next === held || JSON.stringify(next) === JSON.stringify(held) ? held : next
}

/** The same objects in the same order: a list rebuilt from kept items that
 *  changed nothing, so the held list can stay. */
export function sameItems<T>(next: readonly T[], held: readonly T[]): boolean {
  return next.length === held.length && next.every((item, index) => item === held[index])
}
