import type { WorkspaceRef } from "../core/domain/run.ts";

/**
 * Workspace port (ADR-0003). `cwd` works in the current checkout and keeps no commits; the
 * worktree implementation (checkpoint = commit, resume = reset) arrives with the git tools.
 */
export interface Workspace {
  readonly ref: WorkspaceRef;
  /** Records the current file state as a checkpoint; returns a commit sha when the mode supports it. */
  checkpoint(message: string, trailers?: Record<string, string>): Promise<string | undefined>;
  /** Restores the file state of a checkpoint. */
  restore(commit: string | undefined): Promise<void>;
}

export class CwdWorkspace implements Workspace {
  readonly ref: WorkspaceRef;
  constructor(ref: WorkspaceRef) {
    this.ref = ref;
  }
  async checkpoint(): Promise<string | undefined> {
    return undefined;
  }
  async restore(): Promise<void> {
    // Nothing to restore: the files are whatever the checkout holds.
  }
}

export interface WorkspaceFactory {
  open(ref: WorkspaceRef): Promise<Workspace>;
}

export const cwdWorkspaceFactory: WorkspaceFactory = {
  async open(ref) {
    return new CwdWorkspace(ref);
  },
};
