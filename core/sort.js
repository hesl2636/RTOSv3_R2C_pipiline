/**
 * One ordering helper for every module that sorts contract-visible lists.
 *
 * The code-point comparator is the only permitted order (UTF-16 `.sort()`
 * differs for astral characters and is locale-independent but not
 * contract-stable). Callers that need a secondary key compose comparators
 * explicitly and pass them to `Array#sort`.
 */
import { compareCodePoints } from './code-point.js';

/** `[...values]` sorted by code point; never mutates the input. */
export function sorted(values) {
  return [...values].sort(compareCodePoints);
}
