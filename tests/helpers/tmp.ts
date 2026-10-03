import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly project: string;
  write(relative: string, content: string): string;
  cleanup(): void;
}

/** A throwaway home directory and project directory for configuration and storage tests. */
export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "jarvis-test-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(project, ".git"), { recursive: true });
  return {
    root,
    home,
    project,
    write(relative, content) {
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf8");
      return path;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const USER_CONFIG = `version: 1
quotaPools:
  corp:
    window: { minutes: 20 }
    limits: { outputTokens: 60000, requests: 300 }
models:
  deepseek-flash:
    provider: openai-compatible
    baseUrl: https://llm.corp.local/v1
    model: deepseek-flash
    auth: { type: bearer, token: env:CORP_LLM_TOKEN }
    egress: private
    quotaPool: corp
    contextWindow: 128000
    maxOutput: 8192
    supports: { tools: true, jsonMode: true }
  claude:
    provider: anthropic
    model: claude-sonnet
    auth: { type: bearer, token: keychain:anthropic }
    egress: cloud
    contextWindow: 200000
    maxOutput: 16000
roles:
  research: { models: [deepseek-flash] }
`;

export const PROJECT_CONFIG = `version: 1
dataClass: internal
roles:
  research: { models: [deepseek-flash] }
  review: { models: [deepseek-flash], maxOutput: 4096 }
mcp:
  servers:
    jira:
      transport: http
      url: https://mcp.corp.local/atlassian
      auth: { type: bearer, token: keychain:atlassian }
      network: intranet
      profile: atlassian
      allow: [jira.get, jira.search, jira.comment]
workspace:
  setup: "pnpm install --offline"
budget:
  perRun: { outputTokens: 150000 }
profiles:
  ci:
    interactive: false
    workspace: { mode: cwd, allowWrites: false }
    mcp: { deny: ["*.comment", "*.transition"] }
    humanGate: artifact
  looser:
    dataClass: public
`;
