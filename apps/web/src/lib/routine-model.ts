/** A pinned model whose connection is gone: the routine would fail on every run. */
export function isRoutineModelMissing(
  modelKey: string,
  options: readonly { key: string }[],
): boolean {
  return Boolean(modelKey) && !options.some((option) => option.key === modelKey);
}
