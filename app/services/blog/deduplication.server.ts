// Word-overlap similarity: ratio of shared meaningful words between two strings.
// Returns 0.0 (no overlap) to 1.0 (identical).
export function computeSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3),
    );
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  return intersection / Math.max(wa.size, wb.size);
}

// Returns true if `topic` is too similar to any string in `existing`.
export function isDuplicate(topic: string, existing: string[]): boolean {
  return existing.some((e) => computeSimilarity(topic, e) > 0.3);
}
