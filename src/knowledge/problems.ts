/**
 * Knowledge files that could not be read (broken YAML, a front matter its schema refuses, a skill
 * missing a file): passed over, not failed on — pilot: one standard with a typo in its front matter
 * failed every agent step of the project. The ones seen are kept here for `jarvis standards`,
 * `jarvis doctor` and the pages to say, and each is logged once.
 */
const seen = new Map<string, string>();
let listener: ((file: string, message: string) => void) | undefined;

export function reportProblem(file: string, message: string): void {
  if (seen.get(file) === message) return;
  seen.set(file, message);
  listener?.(file, message);
}

/** The knowledge files passed over, with why. */
export function knowledgeProblems(): ReadonlyArray<{ readonly file: string; readonly message: string }> {
  return [...seen].map(([file, message]) => ({ file, message }));
}

/** Where problems are told as they are found (the runtime's log). */
export function onKnowledgeProblem(fn: ((file: string, message: string) => void) | undefined): void {
  listener = fn;
}

/** Tests: start without problems. */
export function forgetKnowledgeProblems(): void {
  seen.clear();
}
