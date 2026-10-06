// Writes dist/build-info.json after `tsc`: the commit the build comes from, so a stale build says so.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  // not a git checkout (an installed package): the build cannot be stale against one
}
writeFileSync("dist/build-info.json", `${JSON.stringify({ commit, builtAt: new Date().toISOString() })}\n`);
