/**
 * tenant-als tests
 *
 * Verifies the AsyncLocalStorage primitives that plumb the active
 * tenant id from `requireAuth` through every async hop down to the
 * Prisma `$extends` tenant-pin extension. These primitives are the
 * load-bearing piece of v3.0 RLS — if they leak between concurrent
 * requests OR fail to propagate across `await`, every subsequent query
 * sees the wrong tenant.
 */
import { describe, it, expect } from "vitest";
import { tenantContextStorage, tenantPinInProgress } from "../tenant-als.js";

describe("tenant-als", () => {
  describe("tenantContextStorage", () => {
    it("returns undefined outside of a run() scope", () => {
      expect(tenantContextStorage.getStore()).toBeUndefined();
    });

    it("exposes the accountId inside the run() callback", () => {
      tenantContextStorage.run({ accountId: "acc_1" }, () => {
        expect(tenantContextStorage.getStore()?.accountId).toBe("acc_1");
      });
    });

    it("propagates the store across awaited boundaries", async () => {
      await tenantContextStorage.run({ accountId: "acc_async" }, async () => {
        await Promise.resolve();
        await new Promise((r) => setImmediate(r));
        expect(tenantContextStorage.getStore()?.accountId).toBe("acc_async");
      });
    });

    it("nested run() shadows the outer store inside the inner scope", () => {
      tenantContextStorage.run({ accountId: "outer" }, () => {
        expect(tenantContextStorage.getStore()?.accountId).toBe("outer");
        tenantContextStorage.run({ accountId: "inner" }, () => {
          expect(tenantContextStorage.getStore()?.accountId).toBe("inner");
        });
        // After the inner scope exits, the outer scope is restored.
        expect(tenantContextStorage.getStore()?.accountId).toBe("outer");
      });
    });

    it("clears the store after the run() callback returns", () => {
      tenantContextStorage.run({ accountId: "ephemeral" }, () => {
        expect(tenantContextStorage.getStore()?.accountId).toBe("ephemeral");
      });
      expect(tenantContextStorage.getStore()).toBeUndefined();
    });

    it("isolates concurrent tenants across parallel async tasks", async () => {
      // CRITICAL invariant: two requests running at the same time on the
      // same Node process must NEVER see each other's tenant id. If this
      // test ever fails, RLS is silently broken in production.
      const seen: Array<string | undefined> = [];
      const taskA = tenantContextStorage.run({ accountId: "acc_A" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(tenantContextStorage.getStore()?.accountId);
      });
      const taskB = tenantContextStorage.run({ accountId: "acc_B" }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(tenantContextStorage.getStore()?.accountId);
      });
      await Promise.all([taskA, taskB]);
      // Order depends on timer fire order, but the SET must contain both.
      expect(new Set(seen)).toEqual(new Set(["acc_A", "acc_B"]));
    });
  });

  describe("tenantPinInProgress", () => {
    it("returns undefined outside of a run() scope", () => {
      expect(tenantPinInProgress.getStore()).toBeUndefined();
    });

    it("returns true inside the run() scope and clears after", () => {
      tenantPinInProgress.run(true, () => {
        expect(tenantPinInProgress.getStore()).toBe(true);
      });
      expect(tenantPinInProgress.getStore()).toBeUndefined();
    });

    it("is independent of tenantContextStorage", () => {
      tenantContextStorage.run({ accountId: "acc_1" }, () => {
        expect(tenantPinInProgress.getStore()).toBeUndefined();
        tenantPinInProgress.run(true, () => {
          expect(tenantPinInProgress.getStore()).toBe(true);
          expect(tenantContextStorage.getStore()?.accountId).toBe("acc_1");
        });
        expect(tenantPinInProgress.getStore()).toBeUndefined();
        expect(tenantContextStorage.getStore()?.accountId).toBe("acc_1");
      });
    });
  });
});
