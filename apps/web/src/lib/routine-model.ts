/** A pinned model whose connection is gone: the routine would fail on every run. */
export function isRoutineModelMissing(
  modelKey: string,
  options: readonly { key: string }[],
): boolean {
  return Boolean(modelKey) && !options.some((option) => option.key === modelKey);
}

/**
 * Only a successful model load can say a pinned model is disconnected. An empty list
 * while loading, or a failed load, would otherwise warn about every routine.
 */
export function shouldWarnRoutineModelMissing(
  load: "loading" | "ready" | "failed",
  modelKey: string,
  options: readonly { key: string }[],
): boolean {
  return load === "ready" && isRoutineModelMissing(modelKey, options);
}
