import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../tools/local/exec.ts";

/**
 * Review Collector (ADR-0019 §5): turns `// REVIEW: …` markers in the workspace into a review
 * package. Markers get stable ids (`REVIEW(R-3):`) written back into the file; comment syntax is
 * recognised, not parsed — any language, stack-neutral (ADR-0021 §5).
 */
export interface ReviewComment {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** ±4 lines around the marker, numbered. */
  readonly snippet: string;
  readonly blobSha: string;
}

export interface ReviewPackage {
  readonly baseCommit?: string;
  readonly headCommit?: string;
  readonly comments: ReviewComment[];
  /** Files where ids were written back. */
  readonly rewritten: string[];
}

const MARKER =
  /^(?<lead>.*?)(?<open>\/\/|#|--|\/\*|<!--|;|\*)\s*REVIEW(?:\((?<id>R-\d+)\))?:\s*(?<text>.*?)(?<close>\s*(?:\*\/|-->))?\s*$/;
const SKIP = /(^|\/)(node_modules|\.git|\.jarvis|dist|coverage|\.pnpm-store)(\/|$)/;
const MAX_BYTES = 2 * 1024 * 1024;

async function listFiles(workspace: string): Promise<string[]> {
  const tracked = await git(["ls-files", "-z"], workspace);
  const untracked = await git(["ls-files", "-z", "--others", "--exclude-standard"], workspace);
  const all = new Set<string>();
  for (const r of [tracked, untracked]) {
    if (r.code !== 0) continue;
    for (const f of r.stdout.split("\0")) if (f && !SKIP.test(f)) all.add(f);
  }
  return [...all].sort();
}

function sha(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function collectReview(workspace: string, baseCommit?: string): Promise<ReviewPackage> {
  const files = await listFiles(workspace);
  const found: Array<{
    file: string;
    lines: string[];
    hits: Array<{ index: number; id?: string; text: string }>;
  }> = [];
  let maxId = 0;
  for (const file of files) {
    const full = join(workspace, file);
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size > MAX_BYTES) continue;
    const buffer = readFileSync(full);
    if (buffer.subarray(0, 4096).includes(0)) continue;
    const text = buffer.toString("utf8");
    if (!text.includes("REVIEW")) continue;
    const lines = text.split("\n");
    const hits: Array<{ index: number; id?: string; text: string }> = [];
    lines.forEach((line, index) => {
      const m = MARKER.exec(line);
      if (!m?.groups) return;
      const id = m.groups.id;
      if (id) maxId = Math.max(maxId, Number(id.slice(2)));
      hits.push({ index, ...(id ? { id } : {}), text: (m.groups.text ?? "").trim() });
    });
    if (hits.length > 0) found.push({ file, lines, hits });
  }

  const comments: ReviewComment[] = [];
  const rewritten: string[] = [];
  for (const entry of found) {
    let changed = false;
    for (const hit of entry.hits) {
      let id = hit.id;
      if (!id) {
        maxId += 1;
        id = `R-${maxId}`;
        entry.lines[hit.index] = (entry.lines[hit.index] as string).replace(/REVIEW:/, `REVIEW(${id}):`);
        changed = true;
      }
      const from = Math.max(0, hit.index - 4);
      const to = Math.min(entry.lines.length, hit.index + 5);
      const snippet = entry.lines
        .slice(from, to)
        .map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`)
        .join("\n");
      comments.push({
        id,
        file: entry.file,
        line: hit.index + 1,
        text: hit.text,
        snippet,
        blobSha: sha(entry.lines.join("\n")),
      });
    }
    if (changed) {
      writeFileSync(join(workspace, entry.file), entry.lines.join("\n"));
      rewritten.push(entry.file);
    }
  }
  const head = await git(["rev-parse", "HEAD"], workspace);
  comments.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  return {
    ...(baseCommit ? { baseCommit } : {}),
    ...(head.code === 0 ? { headCommit: head.stdout.trim() } : {}),
    comments,
    rewritten,
  };
}

/** Removes every REVIEW marker line (or trailing marker) from the workspace (ADR-0019 §5). */
export async function removeMarkers(workspace: string): Promise<string[]> {
  const files = await listFiles(workspace);
  const touched: string[] = [];
  for (const file of files) {
    const full = join(workspace, file);
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("REVIEW")) continue;
    const lines = text.split("\n");
    const kept: string[] = [];
    let changed = false;
    for (const line of lines) {
      const m = MARKER.exec(line);
      if (!m?.groups) {
        kept.push(line);
        continue;
      }
      changed = true;
      const lead = m.groups.lead ?? "";
      // a marker that trails code keeps the code; a marker-only line disappears
      if (lead.trim().length > 0) kept.push(lead.replace(/\s+$/, ""));
    }
    if (changed) {
      writeFileSync(full, kept.join("\n"));
      touched.push(file);
    }
  }
  return touched;
}
