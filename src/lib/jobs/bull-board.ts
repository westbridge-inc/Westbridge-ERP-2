/**
 * Bull-board dashboard setup.
 *
 * Provides a visual UI for inspecting BullMQ queues at /admin/queues.
 * Protected by requireAuth + requirePermission("admin:*") in the app mount.
 *
 * NOTE: requires @bull-board/api and @bull-board/express as dependencies.
 *       npm install @bull-board/api @bull-board/express
 */
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { emailQueue, erpSyncQueue, reportsQueue, cleanupQueue, billingQueue, webhooksQueue } from "./queue.js";

export function createBullBoardAdapter(basePath: string): ExpressAdapter {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(basePath);

  createBullBoard({
    queues: [
      new BullMQAdapter(emailQueue),
      new BullMQAdapter(erpSyncQueue),
      new BullMQAdapter(reportsQueue),
      new BullMQAdapter(cleanupQueue),
      new BullMQAdapter(billingQueue),
      new BullMQAdapter(webhooksQueue),
    ],
    serverAdapter,
  });

  return serverAdapter;
}
