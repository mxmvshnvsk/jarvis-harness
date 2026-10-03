import type { Approval } from "../artifacts/store.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import { git } from "../tools/local/exec.ts";
import type { Runtime } from "./runtime.ts";

/**
 * "Why did Jarvis change this?" (ADR-0001 §14): the chain from a line, a commit or a run back to the
 * task, through the steps, the artifacts with their sources, the people who decided and the tool
 * calls. Everything is read from what the run recorded; nothing is inferred by a model.
 */
export interface CommitInfo {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
  readonly runId?: string;
}

export interface ExplainedArtifact {
  readonly ref: string;
  /** `type/name@version`, as `jarvis status` prints it. */
  readonly label: string;
  readonly type: string;
  readonly name: string;
  readonly step?: string;
  readonly producedBy: string;
  readonly sources: string[];
  readonly approvals: Array<{ actor: string; decision: string; comment?: string; at: string }>;
  /** Lines of the artifact that mention the focus file (when one was asked about). */
  readonly mentions: string[];
}

export interface RunExplanation {
  readonly run: {
    readonly id: string;
    readonly task: string;
    readonly workflow: string;
    readonly state: string;
    readonly owner: string;
    readonly createdAt: string;
    readonly baseCommit?: string;
  };
  readonly steps: Array<{ step: string; iteration: number; status?: string; outcome?: string }>;
  readonly artifacts: ExplainedArtifact[];
  readonly clarifications: Array<{
    id: string;
    kind: string;
    state: string;
    step: string;
    resolvedBy?: string;
  }>;
  readonly tools: Record<string, number>;
  readonly models: { calls: number; outputTokens: number };
  readonly humanEdits: number;
}

export function runIdFromMessage(message: string): string | undefined {
  return /^Jarvis-Run:\s*(\S+)\s*$/m.exec(message)?.[1];
}

export async function commitInfo(cwd: string, rev: string): Promise<CommitInfo | undefined> {
  const r = await git(["show", "-s", "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%B", `${rev}^{commit}`], cwd);
  if (r.code !== 0) return undefined;
  const [sha, subject, author, date, ...rest] = r.stdout.split("\x1f");
  const runId = runIdFromMessage(rest.join("\x1f"));
  return {
    sha: sha as string,
    subject: subject as string,
    author: author as string,
    date: date as string,
    ...(runId ? { runId } : {}),
  };
}

/** The commit that last touched a line (or the file's latest commits with a Jarvis trailer). */
export async function commitForLine(cwd: string, file: string, line: number): Promise<string | undefined> {
  const r = await git(["blame", "--porcelain", "-L", `${line},${line}`, "--", file], cwd);
  if (r.code !== 0) return undefined;
  const sha = r.stdout.split("\n")[0]?.split(" ")[0];
  return sha && !/^0+$/.test(sha) ? sha : undefined;
}

export async function jarvisCommitsForFile(cwd: string, file: string, limit = 50): Promise<CommitInfo[]> {
  const r = await git(["log", `-n${limit}`, "--format=%H", "--", file], cwd);
  if (r.code !== 0) return [];
  const out: CommitInfo[] = [];
  for (const sha of r.stdout.split("\n").filter(Boolean)) {
    const info = await commitInfo(cwd, sha);
    if (info?.runId) out.push(info);
  }
  return out;
}

function producer(a: ArtifactVersion): string {
  const p = a.provenance;
  if (p.kind === "agent") return `agent ${p.agentId}`;
  if (p.kind === "tool") return `tool ${p.capability}`;
  if (p.kind === "human") return `human ${p.actor.id}`;
  return p.kind;
}

function approvalOf(a: Approval) {
  return {
    actor: `${a.actor.kind}:${a.actor.id}`,
    decision: a.decision,
    ...(a.comment ? { comment: a.comment } : {}),
    at: a.createdAt,
  };
}

export function explainRun(runtime: Runtime, run: Run, focusFile?: string): RunExplanation {
  const latest = runtime.artifacts.listLatest(run.id).filter((a) => a.type !== "tool-output");
  const events = runtime.events.list({ runId: run.id, limit: 20_000 });
  const tools: Record<string, number> = {};
  let calls = 0;
  let outputTokens = 0;
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.kind === "tool.call" && typeof p.capability === "string")
      tools[p.capability] = (tools[p.capability] ?? 0) + 1;
    if (e.kind === "model.call") {
      calls += 1;
      outputTokens += typeof p.outputTokens === "number" ? p.outputTokens : 0;
    }
  }
  const artifacts = latest.map((a): ExplainedArtifact => {
    const mentions: string[] = [];
    if (focusFile) {
      try {
        for (const line of runtime.artifacts.text(a).split("\n")) {
          if (line.includes(focusFile)) mentions.push(line.trim().slice(0, 200));
          if (mentions.length >= 3) break;
        }
      } catch {
        // an unreadable blob simply has no mentions
      }
    }
    return {
      ref: `${a.artifactId}@${a.version}`,
      label: `${a.type}/${a.name}@${a.version}`,
      type: a.type,
      name: a.name,
      ...(a.stepId ? { step: a.stepId } : {}),
      producedBy: producer(a),
      sources: a.sourceRefs,
      approvals: runtime.artifacts.approvalsFor(a.artifactId).map(approvalOf),
      mentions,
    };
  });
  return {
    run: {
      id: run.id,
      task: run.task,
      workflow: run.workflow,
      state: run.state,
      owner: `${run.owner.kind}:${run.owner.id}`,
      createdAt: run.createdAt,
      ...(run.workspace.baseCommit ? { baseCommit: run.workspace.baseCommit } : {}),
    },
    steps: runtime.history.list(run.id).map((s) => ({
      step: s.stepId,
      iteration: s.iteration,
      ...(s.status ? { status: s.status } : {}),
      ...(s.outcome ? { outcome: s.outcome } : {}),
    })),
    artifacts,
    clarifications: runtime.interactions
      .listForRun(run.id)
      .filter((i) => i.kind === "clarification" || i.kind === "review")
      .map((i) => ({
        id: i.id,
        kind: i.kind,
        state: i.state,
        step: i.stepId,
        ...(i.resolvedBy ? { resolvedBy: i.resolvedBy } : {}),
      })),
    tools,
    models: { calls, outputTokens },
    humanEdits: latest.filter((a) => a.provenance.kind === "human").length,
  };
}
