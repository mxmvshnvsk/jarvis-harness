import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { parseSecretRef, type SecretRef, type SecretResolver } from "../../core/config/secrets.ts";

const execFileAsync = promisify(execFile);

/**
 * Credential storage for `keychain:ID` references (ADR-0017 §5). Values live in the OS keychain
 * under the actor's key (ADR-0006 §4): macOS Keychain (`security`), libsecret (`secret-tool`) on
 * Linux. Where neither exists — CI containers, tests — a `file` backend keeps a 0600 JSON file under
 * the Jarvis home; `doctor` reports which backend is active.
 */
export type KeychainBackendKind = "macos" | "libsecret" | "windows" | "file";

export interface KeychainBackend {
  readonly kind: KeychainBackendKind;
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  remove(account: string): Promise<boolean>;
}

const SERVICE = "jarvis";

class MacosBackend implements KeychainBackend {
  readonly kind = "macos" as const;
  async get(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        account,
        "-w",
      ]);
      return stdout.replace(/\n$/, "");
    } catch {
      return undefined;
    }
  }
  async set(account: string, value: string): Promise<void> {
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-s",
      SERVICE,
      "-a",
      account,
      "-w",
      value,
    ]);
  }
  async remove(account: string): Promise<boolean> {
    try {
      await execFileAsync("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
      return true;
    } catch {
      return false;
    }
  }
}

class LibsecretBackend implements KeychainBackend {
  readonly kind = "libsecret" as const;
  async get(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("secret-tool", [
        "lookup",
        "service",
        SERVICE,
        "account",
        account,
      ]);
      return stdout.length > 0 ? stdout.replace(/\n$/, "") : undefined;
    } catch {
      return undefined;
    }
  }
  async set(account: string, value: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "secret-tool",
        ["store", "--label", `${SERVICE} ${account}`, "service", SERVICE, "account", account],
        (error) => (error ? reject(error) : resolve()),
      );
      child.stdin?.end(value);
    });
  }
  async remove(account: string): Promise<boolean> {
    try {
      await execFileAsync("secret-tool", ["clear", "service", SERVICE, "account", account]);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Windows: values encrypted per user with DPAPI (`ProtectedData`, CurrentUser scope) through
 * PowerShell and stored next to the file backend's file; only the same Windows user can decrypt.
 */
class WindowsDpapiBackend implements KeychainBackend {
  readonly kind = "windows" as const;
  private readonly file: FileBackend;

  constructor(file: string) {
    this.file = new FileBackend(file);
  }

  private async powershell(script: string, input: string): Promise<string> {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...process.env, JARVIS_DPAPI_INPUT: input }, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim();
  }

  async get(account: string): Promise<string | undefined> {
    const stored = await this.file.get(account);
    if (!stored) return undefined;
    const script =
      "Add-Type -AssemblyName System.Security; " +
      "$b = [Convert]::FromBase64String($env:JARVIS_DPAPI_INPUT); " +
      "$p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'); " +
      "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))";
    return this.powershell(script, stored);
  }

  async set(account: string, value: string): Promise<void> {
    const script =
      "Add-Type -AssemblyName System.Security; " +
      "$b = [Text.Encoding]::UTF8.GetBytes($env:JARVIS_DPAPI_INPUT); " +
      "$p = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser'); " +
      "[Console]::Out.Write([Convert]::ToBase64String($p))";
    const encrypted = await this.powershell(script, value);
    await this.file.set(account, encrypted);
  }

  async remove(account: string): Promise<boolean> {
    return this.file.remove(account);
  }
}

export class FileBackend implements KeychainBackend {
  readonly kind = "file" as const;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private write(data: Record<string, string>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  async get(account: string): Promise<string | undefined> {
    return this.read()[account];
  }
  async set(account: string, value: string): Promise<void> {
    this.write({ ...this.read(), [account]: value });
  }
  async remove(account: string): Promise<boolean> {
    const data = this.read();
    if (!(account in data)) return false;
    delete data[account];
    this.write(data);
    return true;
  }
}

export interface KeychainOptions {
  /** Actor id — the namespace of every entry (ADR-0006 §4). */
  readonly actorId: string;
  /** File for the `file` backend (`~/.jarvis/credentials.json`). */
  readonly file: string;
  /** `JARVIS_KEYCHAIN_BACKEND` override: macos | libsecret | file. */
  readonly backend?: string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly hasCommand?: (name: string) => boolean;
}

export function selectBackend(options: KeychainOptions): KeychainBackend {
  const forced = options.backend;
  if (forced === "file") return new FileBackend(options.file);
  if (forced === "macos") return new MacosBackend();
  if (forced === "libsecret") return new LibsecretBackend();
  if (forced === "windows") return new WindowsDpapiBackend(options.file);
  const platform = options.platform ?? process.platform;
  const has = options.hasCommand ?? defaultHasCommand;
  if (platform === "darwin" && has("security")) return new MacosBackend();
  if (platform === "linux" && has("secret-tool")) return new LibsecretBackend();
  if (platform === "win32") return new WindowsDpapiBackend(options.file);
  return new FileBackend(options.file);
}

function defaultHasCommand(name: string): boolean {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  return dirs.some((d) => d.length > 0 && existsSync(`${d}/${name}`));
}

export class Keychain {
  readonly backend: KeychainBackend;
  private readonly actorId: string;

  constructor(options: KeychainOptions) {
    this.backend = selectBackend(options);
    this.actorId = options.actorId;
  }

  private account(id: string): string {
    return `${this.actorId}/${id}`;
  }

  get(id: string): Promise<string | undefined> {
    return this.backend.get(this.account(id));
  }
  set(id: string, value: string): Promise<void> {
    return this.backend.set(this.account(id), value);
  }
  remove(id: string): Promise<boolean> {
    return this.backend.remove(this.account(id));
  }
}

/** `keychain:ID` → value; resolved values are reported so the Redactor can learn them. */
export class KeychainSecretResolver implements SecretResolver {
  private readonly keychain: Keychain;
  private readonly onResolved: ((value: string) => void) | undefined;
  private readonly cache = new Map<string, string | undefined>();

  constructor(keychain: Keychain, onResolved?: (value: string) => void) {
    this.keychain = keychain;
    this.onResolved = onResolved;
  }

  supports(ref: SecretRef): boolean {
    return parseSecretRef(ref).kind === "keychain";
  }

  async resolve(ref: SecretRef): Promise<string | undefined> {
    const parsed = parseSecretRef(ref);
    if (parsed.kind !== "keychain") return undefined;
    if (this.cache.has(parsed.name)) return this.cache.get(parsed.name);
    const value = await this.keychain.get(parsed.name);
    this.cache.set(parsed.name, value);
    if (value !== undefined) this.onResolved?.(value);
    return value;
  }
}
