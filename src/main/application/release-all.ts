/**
 * Runs every release in order. One that fails must not stop the others, since each frees a
 * different resource, so failures are swallowed here and nothing is left half released.
 */
export function releaseAll(releases: readonly (() => void)[]): () => void {
  return () => {
    for (const release of releases) {
      try {
        release()
      } catch {
        /* Continue releasing the remaining resources. */
      }
    }
  }
}
