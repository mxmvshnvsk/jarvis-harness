import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Runtime } from "../app/runtime.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import { documentToMarkdown } from "./render.ts";
import type { Style } from "./style.ts";

/**
 * An artifact as a file a click can open: the agent's JSON documents rendered as markdown (as
 * `jarvis show` prints them), anything else as stored, under `~/.jarvis/cache/view/<run>/`. Written
 * once per version, only when the terminal makes links (OSC 8).
 */
export function viewFile(runtime: Runtime, a: ArtifactVersion): string | undefined {
  try {
    const dir = join(runtime.loaded.home.cacheDir, "view", a.runId);
    const json = /\.json$/.test(a.name);
    const file = join(dir, `${a.type}-${a.name.replace(/\.json$/, "")}@${a.version}${json ? ".md" : ""}`);
    if (existsSync(file)) return file;
    mkdirSync(dir, { recursive: true });
    const text = runtime.artifacts.text(a);
    let content = text;
    if (json) {
      try {
        content = documentToMarkdown(JSON.parse(text) as Record<string, unknown>);
      } catch {
        content = text;
      }
    }
    writeFileSync(file, content);
    return file;
  } catch {
    return undefined;
  }
}

/** `label` linked to the artifact's file where the terminal makes links; the label alone elsewhere. */
export function artifactLink(st: Style, runtime: Runtime, a: ArtifactVersion, label: string): string {
  if (!st.links) return label;
  const file = viewFile(runtime, a);
  return file ? st.link(pathToFileURL(file).href, label) : label;
}

/** A path in the workspace, linked to the file. */
export function fileLink(st: Style, absolute: string, label: string): string {
  return st.links ? st.link(pathToFileURL(absolute).href, label) : label;
}
