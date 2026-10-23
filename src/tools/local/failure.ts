/**
 * What a failed project command says went wrong, first: its lines that say error (with the file they
 * are under), then its end — before the whole output, which a long run has cut. Pilot: a lint of 517
 * problems — 2 errors among 515 warnings — was cut at its first 64 KB, all warnings; the agent never saw
 * the errors nor the summary line, and spent twelve minutes in the linter's configuration.
 */
const MIN_LINES = 60;
const MAX_ERRORS = 60;
const TAIL = 30;

/** A runner's prefix on each line: turbo's `pkg:lint: `, lerna's `pkg: `. */
const PREFIX = /^[@\w./-]+:[\w:-]+: /;
const strip = (line: string) => line.replace(PREFIX, "");

/** A line that is a file's name alone: the heading of a linter's report, its problems under it. */
const PATH = /^(\/|\.{1,2}\/|[\w@.-]+\/)\S*\.\w+$/;

/** A line that says error — not a warning, not «0 errors». */
function isError(line: string): boolean {
  if (/\b0 errors?\b/i.test(line) && !/[1-9]\d* errors?\b/i.test(line)) return false;
  return /(^|\s)error(\s|:|$)/i.test(line) || /✖|✗|\bERR!|^\s*FAIL\s|\b\w*Error:|\berror TS\d+/.test(line);
}

export function failureDigest(output: string): string | undefined {
  const lines = output.split("\n");
  if (lines.length < MIN_LINES) return undefined;
  const picked: string[] = [];
  let heading: string | undefined;
  let headed: string | undefined;
  let errors = 0;
  // the end is shown on its own: errors are looked for before it
  const end = Math.max(0, lines.length - TAIL);
  for (let i = 0; i < end; i++) {
    const body = strip(lines[i] as string).trim();
    if (PATH.test(body)) {
      heading = lines[i];
      continue;
    }
    if (!isError(body)) continue;
    errors += 1;
    if (picked.length >= MAX_ERRORS) continue;
    if (heading && heading !== headed) {
      picked.push(heading as string);
      headed = heading;
    }
    picked.push(lines[i] as string);
  }
  const tail = lines.slice(end);
  return [
    errors > 0
      ? `[failed — the lines that say error (${errors} of ${lines.length} lines${errors > MAX_ERRORS ? `, the first ${MAX_ERRORS}` : ""}):]`
      : `[failed — no line says error; the end of the ${lines.length} lines below]`,
    ...picked,
    ...(errors > 0 ? [`[…its end:]`] : []),
    ...tail,
    "[the whole output:]",
  ].join("\n");
}

/** Colours, cursor moves and spinner redraws: a terminal's, not words (pilot: «[33m…[0m» on the card). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const CONTROL = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * A hook's (or any refused command's) words: what says error first, then its end (pilot: lefthook's run-lint failed, and its last
 * 40 lines were the tests that passed and the summary — the lint's errors were above them).
 */
export const hookOutput = (r: { stdout: string; stderr: string }) => {
  const text = `${r.stdout}\n${r.stderr}`
    .replace(CONTROL, "")
    .split("\n")
    .map((l) => l.split("\r").at(-1) ?? "")
    .join("\n")
    .trim();
  const end = text.split("\n").slice(-40).join("\n");
  const digest = failureDigest(text);
  return digest ? `${digest.slice(0, digest.lastIndexOf("\n[the whole output:]"))}` : end;
};
