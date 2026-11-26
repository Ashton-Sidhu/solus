import { useState } from "react";

/**
 * Home's first rows stay as they are until the list has laid them out. A
 * change that arrives while the list measures (the host connects, a fresh read
 * answers) starts the layout again, and the launch splash waits for that
 * layout. After the first layout each change shows at once.
 */
export function useFirstLayoutItems<T>(items: readonly T[], laidOut: boolean): readonly T[] {
  const [first, setFirst] = useState<readonly T[] | null>(null);
  if (!laidOut && first === null && items.length > 0) setFirst(items);
  return laidOut || first === null ? items : first;
}
