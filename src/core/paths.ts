import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Layout of `~/.jarvis` (ADR-0001 §3). */
export interface JarvisHome {
  readonly root: string;
  readonly configFile: string;
  readonly dbFile: string;
  readonly runsDir: string;
  readonly artifactsDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  readonly worktreesDir: string;
  readonly socketFile: string;
}

export function jarvisHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): JarvisHome {
  const root = resolve(env.JARVIS_HOME ?? join(home, ".jarvis"));
  return {
    root,
    configFile: env.JARVIS_CONFIG ? resolve(env.JARVIS_CONFIG) : join(root, "config.yaml"),
    dbFile: join(root, "jarvis.db"),
    runsDir: join(root, "runs"),
    artifactsDir: join(root, "artifacts"),
    cacheDir: join(root, "cache"),
    logsDir: env.JARVIS_LOG_DIR ? resolve(env.JARVIS_LOG_DIR) : join(root, "logs"),
    worktreesDir: join(root, "worktrees"),
    socketFile: join(root, "daemon.sock"),
  };
}

/** Layout of `<project>/.jarvis` (ADR-0001 §3). */
export interface ProjectPaths {
  readonly root: string;
  readonly jarvisDir: string;
  readonly configFile: string;
  readonly knowledgeDir: string;
  readonly specsDir: string;
  readonly approvalsDir: string;
  readonly hasConfig: boolean;
  readonly isGitRepo: boolean;
}

export const PROJECT_DIR = ".jarvis";
export const PROJECT_CONFIG = "project.yaml";

export function projectPaths(root: string): ProjectPaths {
  const jarvisDir = join(root, PROJECT_DIR);
  const configFile = join(jarvisDir, PROJECT_CONFIG);
  return {
    root,
    jarvisDir,
    configFile,
    knowledgeDir: join(jarvisDir, "knowledge"),
    specsDir: join(jarvisDir, "specs"),
    approvalsDir: join(jarvisDir, "approvals"),
    hasConfig: existsSync(configFile),
    isGitRepo: existsSync(join(root, ".git")),
  };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds the project root by walking up from `cwd`: the first directory containing
 * `.jarvis/project.yaml`, otherwise the first containing `.git`. Returns undefined when neither exists.
 */
export function discoverProject(cwd: string): ProjectPaths | undefined {
  let dir = resolve(cwd);
  let gitRoot: string | undefined;
  for (;;) {
    if (existsSync(join(dir, PROJECT_DIR, PROJECT_CONFIG))) return projectPaths(dir);
    if (gitRoot === undefined && isDir(join(dir, ".git"))) gitRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot ? projectPaths(gitRoot) : undefined;
}
