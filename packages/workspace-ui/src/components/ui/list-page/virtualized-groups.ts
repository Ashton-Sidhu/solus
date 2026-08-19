export interface VirtualGroup<Row> {
  key: string
  rows: Row[]
}

export type VirtualGroupItem<Group extends VirtualGroup<Row>, Row> =
  | { key: string; kind: 'header'; group: Group }
  | { key: string; kind: 'row'; group: Group; row: Row }

export function virtualGroupItems<Group extends VirtualGroup<Row>, Row>(
  groups: Group[],
  rowKey: (row: Row) => string | number,
  isOpen: (group: Group) => boolean = () => true,
): VirtualGroupItem<Group, Row>[] {
  const items: VirtualGroupItem<Group, Row>[] = []
  for (const group of groups) {
    items.push({ key: `header:${group.key}`, kind: 'header', group })
    if (!isOpen(group)) continue
    for (const row of group.rows) {
      items.push({ key: `row:${group.key}:${rowKey(row)}`, kind: 'row', group, row })
    }
  }
  return items
}
