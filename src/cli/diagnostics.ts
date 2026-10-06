/**
 * The anatomy of an error (rustc, cargo): a code, what happened, and what to do about it. The
 * message says what; the code names the kind, so `jarvis errors <code>` can say more, and the help
 * line gives the next command. Matching is by the message, so every path that reports a failure —
 * `error:` lines, a failed step, a parked run — gets the same help.
 */
export interface Diagnosis {
  readonly code: string;
  readonly title: string;
  /** One line: the next thing to do. */
  readonly help: string;
  /** A paragraph for `jarvis errors <code>`. */
  readonly explain: string;
  readonly match: RegExp;
}

export const DIAGNOSES: readonly Diagnosis[] = [
  {
    code: "J001",
    title: "the model did not answer in time",
    match: /UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|\btimeout\b|timed out/i,
    help: "`jarvis models stats --since 30m` shows whether every attempt is cut at the same length; raise `models.<id>.timeoutMs` if answers are just slow",
    explain:
      "A request to the model ran longer than allowed. When every failed attempt took the same time, something on the way (a gateway, a proxy) cuts requests, not the model; streaming (on by default) keeps such a connection busy. When the times differ, the model is slow: a larger `timeoutMs` for the model, or a smaller prompt.",
  },
  {
    code: "J002",
    title: "the model is unavailable",
    match:
      /provider error \(5\d\d\)|is unavailable|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network error|fetch failed|stream ended before/i,
    help: "the run waits for the model and goes on by itself; `jarvis models stats` and `jarvis models probe <id>` show how it is",
    explain:
      "The gateway answered with a server error, or could not be reached, after its retries. A run does not fail for it: it waits (WAITING_BUDGET, waiting for the model), is checked every `modelWait.checkEveryMinutes`, and fails only after `modelWait.giveUpAfterHours`. In a terminal `jarvis continue` waits in place.",
  },
  {
    code: "J003",
    title: "the endpoint's certificate is not trusted",
    match: /SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|CERT_HAS_EXPIRED/,
    help: "a corporate CA: run with `NODE_OPTIONS=--use-system-ca` so Node trusts the system's certificates",
    explain:
      "Node checks TLS certificates against its own list, which does not contain a company's internal CA. `NODE_OPTIONS=--use-system-ca` makes it use the operating system's store, where the CA usually is.",
  },
  {
    code: "J004",
    title: "credentials are missing or refused",
    match: /\b(401|403)\b|secret \S+ is not available|unauthori[sz]ed|forbidden/i,
    help: "`jarvis auth status`, then `jarvis auth set <id>`; `jarvis doctor` checks every model",
    explain:
      "The model or an MCP server needs a token that is not set for this actor, or refused the one given. Tokens live in the keychain (`jarvis auth set`), referenced from the configuration as `keychain:<id>` or `env:NAME`.",
  },
  {
    code: "J005",
    title: "a quota or budget is used up",
    match: /quota|budget admission denied|budget .* exceeded|rate.?limit/i,
    help: "the run waits for the window (WAITING_BUDGET); `jarvis status <run>` says until when",
    explain:
      "A quota pool (`quotaPools`) or a run/step budget (`budget.perRun`, `budget.perStep`) is used up. A pool's window frees by itself and the run goes on; a run's budget needs a decision: raise it in the configuration and `jarvis resume`.",
  },
  {
    code: "J006",
    title: "the run's own checkout could not be prepared",
    match: /workspace\.setup failed|create worktree|worktree .* is missing/i,
    help: "fix `workspace.setup` in .jarvis/project.yaml, or work in your checkout: `JARVIS_WORKSPACE__MODE=cwd JARVIS_WORKSPACE__ALLOW_WRITES=true jarvis …`",
    explain:
      "In worktree mode each run gets its own checkout and runs `workspace.setup` in it (installing, building). The command's output above says what failed; nothing is left behind. `workspace.cache` keeps dependencies between worktrees so the setup has little to do.",
  },
  {
    code: "J007",
    title: "another process holds the run",
    match: /is held by .* until/i,
    help: "`jarvis status` shows the holder; `--steal` only if that process is dead",
    explain:
      "A run is executed by one process at a time (a lease). When a terminal was closed the lease expires in a minute and a half; `jarvis resume <run> --steal` takes it at once.",
  },
  {
    code: "J008",
    title: "the configuration is invalid",
    match: /invalid configuration|unknown key|Unrecognized key/i,
    help: "`jarvis config show --sources` shows every value and where it comes from",
    explain:
      "A value in ~/.jarvis/config.yaml, .jarvis/project.yaml or a JARVIS_* variable does not match the schema. The message names the path and the file.",
  },
  {
    code: "J009",
    title: "the main checkout has uncommitted changes",
    match: /uncommitted changes/i,
    help: "commit or stash your changes, then run the command again",
    explain:
      "Bringing a run's change onto your branch (`jarvis apply`) needs a clean working tree, so your work and the run's do not mix.",
  },
  {
    code: "J010",
    title: "the model's answer did not match the result schema",
    match: /invalid structured output|response is not JSON|stream chunk is not JSON|has no choices/i,
    help: "`jarvis logs <run> --level error` shows the answer; run the step again (`jarvis resume <run>`), or use another model for the role",
    explain:
      "An agent's result is a JSON document checked against its schema. After repairs the answer still did not fit; the invalid answer is kept as an artifact for reading.",
  },
  {
    code: "J011",
    title: "no recorded answer for this request",
    match: /no cassette entry/i,
    help: "the prompt changed since the recording: `jarvis evals run --suite <suite> --mode record`",
    explain:
      "Replay answers from a cassette keyed by the exact request. A changed prompt, skill or threshold makes a new key; record again and compare with the baseline.",
  },
];

/** The most specific first: a TLS failure is also a "fetch failed", a timeout also a network error. */
const ORDER = ["J003", "J001", "J004", "J011", "J010", "J007", "J006", "J009", "J008", "J005", "J002"];

export function diagnose(message: string | undefined): Diagnosis | undefined {
  if (!message) return undefined;
  for (const code of ORDER) {
    const d = DIAGNOSES.find((x) => x.code === code);
    if (d?.match.test(message)) return d;
  }
  return undefined;
}
