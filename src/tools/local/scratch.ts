import { basename } from "node:path";

/**
 * A file made to try something out, not part of the change: `tmp-eol-test.txt`, `probe.txt`,
 * `nl-probe7.txt`, `scratch_1.js`. Pilot: an agent finding out how line endings were written left ten
 * of them in the run's commits, and the next step reported them as defects.
 */
export function isScratchFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    /^(tmp|temp|scratch|probe)([-_.\d]|$)/.test(name) || /[-_.](probe|scratch)\d*(\.[a-z0-9]+)?$/.test(name)
  );
}
