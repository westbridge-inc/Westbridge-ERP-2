import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAdd, mockGetWaitingCount } = vi.hoisted(() => ({
  mockAdd: vi.fn().mockResolvedValue({ id: "job_1" }),
  mockGetWaitingCount: vi.fn().mockResolvedValue(0),
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockAdd,
    getWaitingCount: mockGetWaitingCount,
    getActiveCount: vi.fn().mockResolvedValue(0),
    getCompletedCount: vi.fn().mockResolvedValue(0),
    getFailedCount: vi.fn().mockResolvedValue(0),
    getFailed: vi.fn().mockResolvedValue([]),
    getWaiting: vi.fn().mockResolvedValue([]),
    getJob: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../redis.js", () => ({
  getRedisConfig: vi.fn().mockReturnValue({ host: "localhost", port: 6379, password: undefined }),
}));

vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  emailQueue,
  erpSyncQueue,
  reportsQueue,
  cleanupQueue,
  webhooksQueue,
  enqueueEmail,
  enqueueReport,
  scheduleCleanupJobs,
} from "../queue.js";

describe("queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWaitingCount.mockResolvedValue(0);
  });

  it("exports all queues", () => {
    expect(emailQueue).toBeDefined();
    expect(erpSyncQueue).toBeDefined();
    expect(reportsQueue).toBeDefined();
    expect(cleanupQueue).toBeDefined();
    expect(webhooksQueue).toBeDefined();
  });

  describe("enqueueEmail", () => {
    it("adds email job to queue", async () => {
      await enqueueEmail({ to: "a@b.com", subject: "Test", html: "<p>Hi</p>" });
      expect(mockAdd).toHaveBeenCalledWith("send", expect.any(Object), expect.any(Object));
    });

    it("rejects when queue is too deep", async () => {
      mockGetWaitingCount.mockResolvedValueOnce(15000);
      await expect(enqueueEmail({ to: "a@b.com", subject: "Test", html: "<p>Hi</p>" })).rejects.toThrow(
        "queue capacity",
      );
    });
  });

  describe("enqueueReport", () => {
    it("adds report job to queue and returns ID", async () => {
      const id = await enqueueReport({
        accountId: "acc_1",
        reportType: "revenue",
        params: {},
        requestedBy: "usr_1",
      });
      expect(id).toBe("job_1");
    });

    it("rejects when queue is too deep", async () => {
      mockGetWaitingCount.mockResolvedValueOnce(600);
      await expect(
        enqueueReport({ accountId: "acc_1", reportType: "revenue", params: {}, requestedBy: "usr_1" }),
      ).rejects.toThrow("queue capacity");
    });
  });

  describe("scheduleCleanupJobs", () => {
    it("schedules session and audit log cleanup", async () => {
      await scheduleCleanupJobs();
      expect(mockAdd).toHaveBeenCalledTimes(6);
    });
  });
});
