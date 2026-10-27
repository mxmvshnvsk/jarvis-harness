import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mapEntriesOf, snapshotMapsIn } from "../../src/design/contracts.ts";
import { MAP_CLIENT, mapEndpointsOf, withMapEndpoints } from "../../src/knowledge/catalog.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("a BFF's contracts from its snapshot maps (pilot: contracts.json said it served and called nothing)", () => {
  it("finds the maps, reads routes as served and services as served and called", () => {
    dir = mkdtempSync(join(tmpdir(), "maps-"));
    mkdirSync(join(dir, "apps/server/__snapshots__"), { recursive: true });
    writeFileSync(
      join(dir, "apps/server/__snapshots__/routes-shop.json"),
      JSON.stringify([
        { method: "POST", path: "/api/orders" },
        { method: "GET", path: "/healthmonitor" },
      ]),
    );
    writeFileSync(
      join(dir, "apps/server/__snapshots__/services-shop.json"),
      JSON.stringify({
        "orders.create": { path: "/api/orders", url: "http://gateway/env-orders-api/orders" },
      }),
    );
    const tracked = [
      "apps/server/__snapshots__/routes-shop.json",
      "apps/server/__snapshots__/services-shop.json",
      "apps/server/src/index.ts",
    ];
    const maps = snapshotMapsIn(tracked);
    expect(maps.map((m) => m.files)).toEqual([
      ["apps/server/__snapshots__/routes-*.json"],
      ["apps/server/__snapshots__/services-*.json"],
    ]);
    const { entries, files } = mapEntriesOf(dir, maps);
    expect(files).toHaveLength(2);
    const { serves, calls } = mapEndpointsOf(entries);
    expect(serves.map((e) => `${e.method ?? "*"} ${e.path}`)).toEqual([
      "POST /api/orders",
      "GET /healthmonitor",
      "* /api/orders",
    ]);
    expect(calls).toEqual([
      {
        path: "/env-orders-api/orders",
        url: "http://gateway/env-orders-api/orders",
        handler: "orders.create",
        file: "apps/server/__snapshots__/services-shop.json",
        client: MAP_CLIENT,
      },
    ]);
    // the code's own endpoint is not doubled by the map
    const doc = withMapEndpoints(
      {
        version: 1,
        service: "shop",
        serves: [{ method: "POST", path: "/api/orders", file: "apps/server/src/orders.ts" }],
        calls: [],
        produces: [],
        consumes: [],
      } as never,
      entries,
    );
    expect(doc.serves.map((e) => `${e.method ?? "*"} ${e.path}`)).toEqual([
      "POST /api/orders",
      "GET /healthmonitor",
    ]);
    expect(doc.calls).toHaveLength(1);
  });
});
