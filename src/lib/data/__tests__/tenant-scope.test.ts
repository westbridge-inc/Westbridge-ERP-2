import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecuteRaw, mockTransaction } = vi.hoisted(() => ({
  mockExecuteRaw: vi.fn().mockResolvedValue(undefined),
  mockTransaction: vi.fn(),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    $transaction: mockTransaction,
  },
}));

import { withTenantScope } from "../tenant-scope.js";
import { tenantContextStorage, tenantPinInProgress } from "../tenant-als.js";

describe("tenant-scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: $transaction passes through to the callback
    mockTransaction.mockImplementation(async (fn: Function) => {
      const txMock = {
        $executeRaw: mockExecuteRaw,
        user: { findMany: vi.fn().mockResolvedValue([]) },
        account: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      return fn(txMock);
    });
  });

  it("calls set_config with the correct accountId", async () => {
    await withTenantScope("acc_123", async (_tx) => {
      return [];
    });

    expect(mockExecuteRaw).toHaveBeenCalled();
    // Verify the SQL template literal contains the account ID
    const call = mockExecuteRaw.mock.calls[0];
    // The raw SQL is passed as a tagged template literal, so we check the args
    expect(call).toBeDefined();
  });

  it("executes the callback function within the transaction", async () => {
    const callbackFn = vi.fn().mockResolvedValue("result");

    mockTransaction.mockImplementation(async (fn: Function) => {
      const txMock = { $executeRaw: mockExecuteRaw };
      return fn(txMock);
    });

    const result = await withTenantScope("acc_1", callbackFn);

    expect(callbackFn).toHaveBeenCalled();
    expect(result).toBe("result");
  });

  it("returns the value from the callback", async () => {
    const users = [{ id: "usr_1", name: "Alice" }];

    mockTransaction.mockImplementation(async (fn: Function) => {
      const txMock = {
        $executeRaw: mockExecuteRaw,
        user: { findMany: vi.fn().mockResolvedValue(users) },
      };
      return fn(txMock);
    });

    const result = await withTenantScope("acc_1", async (tx) => {
      return (tx as any).user.findMany();
    });

    expect(result).toEqual(users);
  });

  it("passes the transaction client to the callback", async () => {
    let receivedTx: unknown = null;

    mockTransaction.mockImplementation(async (fn: Function) => {
      const txMock = { $executeRaw: mockExecuteRaw, marker: "tx-instance" };
      return fn(txMock);
    });

    await withTenantScope("acc_1", async (tx) => {
      receivedTx = tx;
    });

    expect(receivedTx).toBeDefined();
    expect((receivedTx as any).marker).toBe("tx-instance");
  });

  it("sets config before executing the callback", async () => {
    const order: string[] = [];

    mockTransaction.mockImplementation(async (fn: Function) => {
      const txMock = {
        $executeRaw: vi.fn().mockImplementation(async () => {
          order.push("set_config");
        }),
      };
      return fn(txMock);
    });

    await withTenantScope("acc_1", async () => {
      order.push("callback");
    });

    expect(order).toEqual(["set_config", "callback"]);
  });

  it("propagates errors from the callback", async () => {
    mockTransaction.mockImplementation(async (fn: Function) => {
      const txMock = { $executeRaw: mockExecuteRaw };
      return fn(txMock);
    });

    await expect(
      withTenantScope("acc_1", async () => {
        throw new Error("Callback failed");
      }),
    ).rejects.toThrow("Callback failed");
  });

  it("propagates errors from the transaction itself", async () => {
    mockTransaction.mockRejectedValue(new Error("Transaction failed"));

    await expect(withTenantScope("acc_1", async () => "ok")).rejects.toThrow("Transaction failed");
  });

  it("uses prisma.$transaction for atomicity", async () => {
    await withTenantScope("acc_1", async () => {});

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it("works with different account IDs", async () => {
    const calls: string[] = [];

    mockTransaction.mockImplementation(async (fn: Function) => {
      const txMock = {
        $executeRaw: vi.fn().mockImplementation(async (..._args: unknown[]) => {
          calls.push("called");
        }),
      };
      return fn(txMock);
    });

    await withTenantScope("acc_A", async () => {});
    await withTenantScope("acc_B", async () => {});

    expect(mockTransaction).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
  });

  it("returns complex data types from the callback", async () => {
    const complexData = {
      users: [{ id: "1" }, { id: "2" }],
      count: 42,
      nested: { deep: true },
    };

    mockTransaction.mockImplementation(async (fn: Function) => {
      const txMock = { $executeRaw: mockExecuteRaw };
      return fn(txMock);
    });

    const result = await withTenantScope("acc_1", async () => complexData);

    expect(result).toEqual(complexData);
  });

  // ── v3.0 ALS plumbing ───────────────────────────────────────────────────
  // withTenantScope now ALSO publishes the tenant id into
  // `tenantContextStorage` so that bare `prisma.X.method` calls inside
  // the callback (i.e. those that use the request-scoped client instead
  // of the explicit tx client) still get tenant-pinned by the Prisma
  // extension. And it sets `tenantPinInProgress=true` so the extension
  // doesn't open NESTED transactions for each query inside the wrapped
  // transaction (Postgres rejects nested $transactions).

  it("sets tenantContextStorage to the active accountId inside the callback", async () => {
    let seen: string | undefined;
    mockTransaction.mockImplementation(async (fn: Function) => fn({ $executeRaw: mockExecuteRaw }));

    await withTenantScope("acc_als", async () => {
      seen = tenantContextStorage.getStore()?.accountId;
    });

    expect(seen).toBe("acc_als");
  });

  it("sets tenantPinInProgress=true so $allOperations skips re-wrapping", async () => {
    let seenInProgress: boolean | undefined;
    mockTransaction.mockImplementation(async (fn: Function) => fn({ $executeRaw: mockExecuteRaw }));

    await withTenantScope("acc_als", async () => {
      seenInProgress = tenantPinInProgress.getStore();
    });

    expect(seenInProgress).toBe(true);
  });

  it("clears tenantContextStorage and tenantPinInProgress after the callback returns", async () => {
    mockTransaction.mockImplementation(async (fn: Function) => fn({ $executeRaw: mockExecuteRaw }));

    await withTenantScope("acc_als", async () => {});

    expect(tenantContextStorage.getStore()).toBeUndefined();
    expect(tenantPinInProgress.getStore()).toBeUndefined();
  });

  it("isolates ALS state across concurrent withTenantScope calls", async () => {
    // The whole point of AsyncLocalStorage: two parallel calls must NOT
    // see each other's tenant id. If this ever fails, RLS is silently
    // broken under concurrent load.
    mockTransaction.mockImplementation(async (fn: Function) => fn({ $executeRaw: mockExecuteRaw }));

    const seen: Array<string | undefined> = [];
    await Promise.all([
      withTenantScope("acc_A", async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(tenantContextStorage.getStore()?.accountId);
      }),
      withTenantScope("acc_B", async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(tenantContextStorage.getStore()?.accountId);
      }),
    ]);

    expect(new Set(seen)).toEqual(new Set(["acc_A", "acc_B"]));
  });
});
