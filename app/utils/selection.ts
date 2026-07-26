export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Shift-click behaviour: select the inclusive range between the anchor and the
 * target within the current visual order. Falls back to a toggle when there is
 * no anchor or the anchor is no longer visible.
 */
export function rangeSelect(
  orderedIds: readonly string[],
  selected: ReadonlySet<string>,
  anchorId: string | null,
  targetId: string,
): Set<string> {
  const anchorIndex = anchorId ? orderedIds.indexOf(anchorId) : -1;
  const targetIndex = orderedIds.indexOf(targetId);
  if (anchorIndex === -1 || targetIndex === -1) return toggleId(selected, targetId);
  const next = new Set(selected);
  const [from, to] =
    anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  for (let i = from; i <= to; i++) next.add(orderedIds[i]!);
  return next;
}

export function toggleGroup(
  selected: ReadonlySet<string>,
  groupIds: readonly string[],
): Set<string> {
  const next = new Set(selected);
  const allSelected = groupIds.every((id) => next.has(id));
  for (const id of groupIds) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return next;
}
