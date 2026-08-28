/** Compare one source against the baseline loaded immediately before syncing it. */
export function findNewLibraryItems<T extends { aweme_id: string }>(
  refreshed: T[],
  previousIds: ReadonlySet<string>,
): T[] {
  return refreshed.filter((item) => !previousIds.has(item.aweme_id));
}
