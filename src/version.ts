import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PackageJson {
  readonly name: string;
  readonly version: string;
}

let cached: PackageJson | undefined;

/** Reads name and version from the package's own package.json (works from src/ and dist/). */
export function packageInfo(): PackageJson {
  if (!cached) {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PackageJson;
    cached = { name: parsed.name, version: parsed.version };
  }
  return cached;
}
