import { LIBRARY_A } from './library-a.js'
import { LIBRARY_B } from './library-b.js'
import { LIBRARY_C } from './library-c.js'
import type { SeedCase } from './types.js'

export * from './types.js'

export const LIBRARY: SeedCase[] = [...LIBRARY_A, ...LIBRARY_B, ...LIBRARY_C]

export function casesForSplit(split: 'public' | 'dev' | 'blind'): SeedCase[] {
  return LIBRARY.filter((c) => c.split === split)
}

/**
 * Every defect class the library covers, DERIVED from the library rather than
 * hand-listed. A hardcoded list drifts from the corpus silently, and any file
 * that carries it is a disclosure risk if it ever reaches an implementer.
 */
export const DEFECT_CLASSES: string[] = [
  ...new Set(LIBRARY.flatMap((c) => c.defects.map((d) => d.class))),
].sort()

/** Classes taught by the labeled public set. Recall on these is SEEN recall. */
export const SEEN_CLASSES: string[] = [
  ...new Set(
    LIBRARY.filter((c) => c.split === 'public').flatMap((c) => c.defects.map((d) => d.class)),
  ),
].sort()

/** Classes that appear only in hidden splits. Recall on these is the generalization signal. */
export const UNSEEN_CLASSES: string[] = DEFECT_CLASSES.filter((c) => !SEEN_CLASSES.includes(c))
