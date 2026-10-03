import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * Content-addressed blob store (ADR-0001 §12, ADR-0005 §1): large documents and raw tool outputs
 * live as files under `~/.jarvis/artifacts/blobs/<aa>/<sha256>`; SQLite keeps only metadata.
 * Everything written here must already be redacted (ADR-0010 §1).
 */
export interface BlobInfo {
  readonly contentRef: string;
  readonly size: number;
  readonly mediaType?: string;
  readonly createdAt: string;
}

export function contentRefOf(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class BlobStore {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly clock: () => Date;

  constructor(db: DatabaseSync, root: string, clock: () => Date = () => new Date()) {
    this.db = db;
    this.root = root;
    this.clock = clock;
  }

  path(contentRef: string): string {
    return join(this.root, contentRef.slice(0, 2), contentRef);
  }

  has(contentRef: string): boolean {
    return existsSync(this.path(contentRef));
  }

  put(content: Buffer | string, mediaType?: string): BlobInfo {
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const contentRef = contentRefOf(buffer);
    const path = this.path(contentRef);
    if (!existsSync(path)) {
      mkdirSync(join(this.root, contentRef.slice(0, 2)), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, buffer);
      renameSync(tmp, path);
    }
    const createdAt = this.clock().toISOString();
    this.db
      .prepare("INSERT OR IGNORE INTO blobs (content_ref, size, media_type, created_at) VALUES (?, ?, ?, ?)")
      .run(contentRef, buffer.length, mediaType ?? null, createdAt);
    return { contentRef, size: buffer.length, createdAt, ...(mediaType ? { mediaType } : {}) };
  }

  get(contentRef: string): Buffer {
    return readFileSync(this.path(contentRef));
  }

  getText(contentRef: string): string {
    return this.get(contentRef).toString("utf8");
  }

  info(contentRef: string): BlobInfo | undefined {
    const row = this.db
      .prepare("SELECT content_ref, size, media_type, created_at FROM blobs WHERE content_ref = ?")
      .get(contentRef) as
      | { content_ref: string; size: number; media_type: string | null; created_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      contentRef: row.content_ref,
      size: row.size,
      createdAt: row.created_at,
      ...(row.media_type ? { mediaType: row.media_type } : {}),
    };
  }

  /** Size on disk, for `doctor`/`stats`. */
  sizeOf(contentRef: string): number | undefined {
    try {
      return statSync(this.path(contentRef)).size;
    } catch {
      return undefined;
    }
  }
}
