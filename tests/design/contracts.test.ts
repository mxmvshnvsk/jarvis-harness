import { describe, expect, it } from "vitest";
import {
  checkContracts,
  contractsSection,
  entriesOf,
  matchesOf,
  mentionsIn,
  segmentsOf,
} from "../../src/design/contracts.ts";
import { sandbox } from "../helpers/tmp.ts";

describe("API methods in the sources against a contract map", () => {
  it("finds METHOD /path once, in pages' markup too, without the punctuation after it", () => {
    const found = mentionsIn([
      { from: "the task", text: "Use GET /logistics-api/delivery-slots. Then POST /api/orders?x=1;" },
      {
        from: "page (77)",
        text: '<p>GET&nbsp;/logistics-api/delivery-slots</p> "DELETE http://host/billing-api/invoices/{id}" get /lower',
      },
    ]);
    expect(found.map((m) => `${m.method} ${m.path} @${m.from}`)).toEqual([
      "GET /logistics-api/delivery-slots @the task",
      "POST /api/orders?x=1 @the task",
      "DELETE http://host/billing-api/invoices/{id} @page (77)",
    ]);
    expect(segmentsOf("http://SERVICE_HOST/billing-api/invoices/?a=1")).toEqual(["billing-api", "invoices"]);
  });

  it("matches the end of a path or url; parameters match any segment; a method only when the map has one", () => {
    const entries = [
      ...entriesOf("services.json", {
        "billing.invoice": {
          path: "/api/invoices/{invoiceId}",
          url: "http://SERVICE_HOST/billing-api/invoices/{id}",
        },
        local: { path: "/lead", url: null },
      }),
      ...entriesOf("routes.json", [
        { method: "GET", path: "/api/invoices/{invoiceId}" },
        { method: "POST", path: "/lead" },
      ]),
    ];
    expect(entries).toHaveLength(4);
    const m = (method: string, path: string) =>
      matchesOf({ method, path, from: "t" }, entries).map((e) => `${e.file}:${e.key ?? e.method}`);
    expect(m("GET", "/invoices/:id")).toEqual(["services.json:billing.invoice", "routes.json:GET"]);
    expect(m("DELETE", "/billing-api/invoices/42")).toEqual(["services.json:billing.invoice"]);
    expect(m("GET", "/lead")).toEqual(["services.json:local"]); // routes.json has it as POST only
    expect(m("GET", "/billing-api/refunds")).toEqual([]);
    // a whole path wins over an end: /api/orders is the route, not a url ending in {type}/orders
    const orders = entriesOf("s.json", {
      "orders.all": { path: "/api/orders/all", url: "http://h/orders-api/form/{type}/orders" },
      "orders.create": { path: "/api/orders", url: "http://h/orders-api/form/order" },
    });
    expect(matchesOf({ method: "POST", path: "/api/orders", from: "t" }, orders).map((e) => e.key)).toEqual([
      "orders.create",
    ]);
  });

  it("reads the maps a project names (a * in the file name), says what it could not read", () => {
    const sb = sandbox();
    try {
      sb.write(
        "project/maps/services-web.json",
        JSON.stringify({ "a.b": { path: "/api/b", url: "http://h/x-api/b" } }),
      );
      sb.write("project/maps/services-broken.json", "{not json");
      const check = checkContracts(
        sb.project,
        [{ files: ["maps/services-*.json", "maps/missing.json"], about: "routes" }],
        [{ from: "the task", text: "GET /x-api/b and GET /x-api/c" }],
      );
      expect(check?.files).toEqual(["maps/services-web.json"]);
      expect(check?.unreadable).toEqual(["maps/services-broken.json", "maps/missing.json"]);
      const text = contractsSection(check as never);
      expect(text).toContain(
        "- `GET /x-api/b` (the task) — in the map: `a.b` · path `/api/b` · url `http://h/x-api/b` (services-web.json)",
      );
      expect(text).toContain("- `GET /x-api/c` (the task) — **not in the map**");
      expect(text).toContain("Not read: `maps/services-broken.json`, `maps/missing.json`.");
      // nothing to check: no section
      expect(checkContracts(sb.project, [], [{ from: "t", text: "GET /x" }])).toBeUndefined();
      expect(
        checkContracts(sb.project, [{ files: ["maps/*.json"] }], [{ from: "t", text: "no methods" }]),
      ).toBeUndefined();
      // a path out of the repository is not read
      expect(
        checkContracts(sb.project, [{ files: ["../x.json"] }], [{ from: "t", text: "GET /x" }])?.unreadable,
      ).toEqual(["../x.json"]);
    } finally {
      sb.cleanup();
    }
  });
});
