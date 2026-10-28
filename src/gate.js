/**
 * Gate seam.
 *
 * Ticket #20 replaces this with `expect.outputs` globbing followed by
 * `gate[].command` execution in manifest order. Until then the seam exists so
 * `submit` has exactly one place to call and the contract does not move.
 */
export async function checkGates(_context) {
  return { ok: true };
}
