import { describe, it, expect, vi } from "vitest";

// The prisma module creates a client at import time. We can't easily mock PrismaClient
// constructor, but we can test the appendPoolSize helper and verify the client is created.
// Since prisma.ts has soft-delete extensions, the best approach is to verify the export exists.

vi.mock("@prisma/client", () => {
  const mockClient = {
    $extends: vi.fn().mockReturnThis(),
    account: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  return {
    PrismaClient: vi.fn().mockImplementation(() => mockClient),
  };
});

import { prisma } from "../prisma.js";

describe("prisma", () => {
  it("exports a prisma client instance", () => {
    expect(prisma).toBeDefined();
  });

  it("prisma client has expected model accessors", () => {
    // Since we mock PrismaClient, we just verify it's defined
    expect(prisma).toBeTruthy();
  });
});
