import type { Node } from "@xyflow/svelte";
import { findParentCycleBreaks } from "../../../../shared/diagram-types";

export const GROUP_W = 320;
export const GROUP_H = 220;
export const COLLAPSED_H = 48;
export const NODE_WIDTH_EST = 200;
export const NODE_HEIGHT_EST = 60;
export const GROUP_PAD = 18;
export const GROUP_Z = -1000;
export const BACK_Z = -2000;

export type Box = { x: number; y: number; w: number; h: number };

export type Membership = {
  parentId: string | undefined;
  position: { x: number; y: number };
};

export const sizeStyle = (w: number, h: number) => `width:${w}px;height:${h}px`;

export function nodeDepth(n: Node, byId: Map<string, Node>): number {
  let depth = 0;
  let cur = n.parentId ? byId.get(n.parentId) : undefined;
  while (cur) {
    depth++;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return depth;
}

export function orderParentsFirst(arr: Node[]): Node[] {
  const detach = findParentCycleBreaks(arr);
  const byId = new Map(arr.map((n) => [n.id, n]));
  const ordered: Node[] = [];
  const seen = new Set<string>();
  const inProgress = new Set<string>();
  const visit = (n: Node) => {
    if (seen.has(n.id) || inProgress.has(n.id)) return;
    inProgress.add(n.id);
    const parent =
      detach.has(n.id) || !n.parentId ? undefined : byId.get(n.parentId);
    if (parent) visit(parent);
    inProgress.delete(n.id);
    seen.add(n.id);
    ordered.push(n);
  };
  for (const n of arr) visit(n);
  return ordered.map((n) => {
    const zIndex = n.data.sentToBack
      ? BACK_Z
      : n.data.group
        ? GROUP_Z
        : undefined;
    if (detach.has(n.id)) {
      const { parentId: _p, ...rest } = n;
      return { ...rest, zIndex, data: { ...n.data, parentId: undefined } };
    }
    return n.zIndex === zIndex ? n : { ...n, zIndex };
  });
}

export function absoluteBox(n: Node, byId: Map<string, Node>): Box {
  let { x, y } = n.position;
  let parent = n.parentId ? byId.get(n.parentId) : undefined;
  while (parent) {
    x += parent.position.x;
    y += parent.position.y;
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  const w = n.width ?? (n.data.group ? GROUP_W : NODE_WIDTH_EST);
  const h = n.height ?? (n.data.group ? GROUP_H : NODE_HEIGHT_EST);
  return { x, y, w, h };
}

export function isSelfOrDescendant(
  candidate: string,
  nodeId: string,
  byId: Map<string, Node>,
): boolean {
  let cur: Node | undefined = byId.get(candidate);
  while (cur) {
    if (cur.id === nodeId) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

export function centreOf(
  n: Node,
  byId: Map<string, Node>,
): { cx: number; cy: number } {
  const b = absoluteBox(n, byId);
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
}

export function pointInBox(cx: number, cy: number, box: Box): boolean {
  return (
    cx >= box.x &&
    cx <= box.x + box.w &&
    cy >= box.y &&
    cy <= box.y + box.h
  );
}

export function deepestGroupAt(
  nodes: Node[],
  cx: number,
  cy: number,
  draggedId: string,
  byId: Map<string, Node>,
): Node | undefined {
  let target: Node | undefined;
  let targetDepth = -1;
  for (const n of nodes) {
    if (!n.data.group || n.id === draggedId) continue;
    if (n.data.collapsed) continue;
    if (isSelfOrDescendant(n.id, draggedId, byId)) continue;
    if (!pointInBox(cx, cy, absoluteBox(n, byId))) continue;
    const depth = nodeDepth(n, byId);
    if (depth > targetDepth) {
      target = n;
      targetDepth = depth;
    }
  }
  return target;
}

export function groupMembershipUpdates(
  group: Node,
  against: Node[],
  byId: Map<string, Node>,
  opts: { swallow: boolean; eject: boolean },
): Map<string, Membership> {
  const box = absoluteBox(group, byId);
  const level = group.parentId ?? undefined;
  const out = new Map<string, Membership>();
  for (const n of against) {
    if (n.id === group.id) continue;
    if (isSelfOrDescendant(group.id, n.id, byId)) continue;
    const b = absoluteBox(n, byId);
    const inside = pointInBox(b.x + b.w / 2, b.y + b.h / 2, box);
    const isChild = (n.parentId ?? undefined) === group.id;
    if (opts.swallow && !isChild && (n.parentId ?? undefined) === level && inside) {
      out.set(n.id, {
        parentId: group.id,
        position: { x: b.x - box.x, y: b.y - box.y },
      });
    } else if (opts.eject && isChild && !inside) {
      out.set(n.id, { parentId: undefined, position: { x: b.x, y: b.y } });
    }
  }
  return out;
}

export function applyMembership(
  arr: Node[],
  updates: Map<string, Membership>,
): Node[] {
  if (updates.size === 0) return arr;
  return arr.map((n) => {
    const u = updates.get(n.id);
    if (!u) return n;
    if (u.parentId) {
      return {
        ...n,
        parentId: u.parentId,
        position: u.position,
        data: { ...n.data, parentId: u.parentId },
      };
    }
    const { parentId: _p, ...rest } = n;
    return {
      ...rest,
      position: u.position,
      data: { ...n.data, parentId: undefined },
    };
  });
}

export function pruneCyclicMemberships(
  updates: Map<string, Membership>,
  byId: Map<string, Node>,
) {
  const parentAfter = (id: string): string | undefined =>
    updates.has(id) ? updates.get(id)!.parentId : byId.get(id)?.parentId;
  for (const [id, u] of updates) {
    const seen = new Set<string>();
    let cur = u.parentId;
    while (cur) {
      if (cur === id) {
        updates.delete(id);
        break;
      }
      if (seen.has(cur)) break;
      seen.add(cur);
      cur = parentAfter(cur);
    }
  }
}

export function autoGrowGroups(arr: Node[], groupIds: Set<string>): Node[] {
  let next = arr;
  for (const gid of groupIds) {
    const group = next.find((n) => n.id === gid);
    if (!group?.data.group) continue;
    if (group.data.collapsed) continue;
    const children = next.filter((n) => (n.parentId ?? undefined) === gid);
    if (!children.length) continue;
    const curW = group.width ?? GROUP_W;
    const curH = group.height ?? GROUP_H;
    let minX = 0;
    let minY = 0;
    let maxX = curW;
    let maxY = curH;
    for (const c of children) {
      const w = c.width ?? (c.data.group ? GROUP_W : NODE_WIDTH_EST);
      const h = c.height ?? (c.data.group ? GROUP_H : NODE_HEIGHT_EST);
      minX = Math.min(minX, c.position.x - GROUP_PAD);
      minY = Math.min(minY, c.position.y - GROUP_PAD);
      maxX = Math.max(maxX, c.position.x + w + GROUP_PAD);
      maxY = Math.max(maxY, c.position.y + h + GROUP_PAD);
    }
    const dx = Math.min(0, minX);
    const dy = Math.min(0, minY);
    const width = Math.round(maxX - dx);
    const height = Math.round(maxY - dy);
    if (dx === 0 && dy === 0 && width === curW && height === curH) continue;
    next = next.map((n) => {
      if (n.id === gid) {
        return {
          ...n,
          position: { x: group.position.x + dx, y: group.position.y + dy },
          width,
          height,
          style: sizeStyle(width, height),
          data: { ...n.data, width, height },
        };
      }
      if ((dx !== 0 || dy !== 0) && (n.parentId ?? undefined) === gid) {
        return {
          ...n,
          position: { x: n.position.x - dx, y: n.position.y - dy },
        };
      }
      return n;
    });
  }
  return next;
}

export function detachChildrenOf(source: Node[], groupIds: Set<string>): Node[] {
  const byId = new Map(source.map((n) => [n.id, n]));
  return source.map((n) => {
    if (!n.parentId || !groupIds.has(n.parentId)) return n;
    let x = n.position.x;
    let y = n.position.y;
    let ancestor: Node | undefined = byId.get(n.parentId);
    while (ancestor && groupIds.has(ancestor.id)) {
      x += ancestor.position.x;
      y += ancestor.position.y;
      ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
    }
    const newParentId = ancestor?.id;
    const { parentId: _p, ...rest } = n;
    return {
      ...rest,
      ...(newParentId ? { parentId: newParentId } : {}),
      position: { x, y },
      data: { ...n.data, parentId: newParentId },
    };
  });
}
