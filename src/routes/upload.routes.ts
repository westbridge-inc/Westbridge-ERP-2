/**
 * File upload route: proxies multipart uploads to ERPNext's upload_file API.
 *
 * Uses the built-in Node buffer approach (no multer dependency) to read the
 * uploaded file from the request and forward it to ERPNext as multipart/form-data.
 */

import { Router, Request, Response } from "express";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { requireAuth, requireCsrf, rateLimit, toWebRequest } from "../middleware/auth.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import * as Sentry from "@sentry/node";
import { logger } from "../lib/logger.js";

const ERPNEXT_URL = process.env.ERPNEXT_URL ?? "http://localhost:8080";
const ACCOUNT_HEADER = "X-Westbridge-Account-Id";

/** Maximum file size: 10 MB */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/json",
  "application/zip",
]);

const router = Router();

// ─── POST /erp/upload ────────────────────────────────────────────────────────

router.post(
  "/erp/upload",
  requireAuth,
  requireCsrf,
  rateLimit("authenticated", "/api/erp/upload"),
  async (req: Request, res: Response) => {
    const start = Date.now();
    const requestId = getRequestId(toWebRequest(req));
    const meta = () => apiMeta({ request_id: requestId });
    const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

    try {
      const session = req.session!;
      const ctx = auditContext(toWebRequest(req));

      if (!session.erpnextSid) {
        res.set(responseHeaders());
        return res
          .status(401)
          .json(apiError("UNAUTHORIZED", "ERP session not available. Please log in again.", undefined, meta()));
      }

      // ── Parse multipart manually via raw body buffering ──────────────────
      // Express does not parse multipart by default. We read the raw body
      // chunks and extract boundary-delimited parts. For simplicity, we
      // collect the entire body into a buffer (capped at MAX_FILE_SIZE).

      const contentType = req.headers["content-type"] ?? "";
      if (!contentType.includes("multipart/form-data")) {
        res.set(responseHeaders());
        return res
          .status(400)
          .json(apiError("BAD_REQUEST", "Content-Type must be multipart/form-data", undefined, meta()));
      }

      // Collect raw body
      const chunks: Buffer[] = [];
      let totalSize = 0;

      await new Promise<void>((resolve, reject) => {
        req.on("data", (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > MAX_FILE_SIZE) {
            reject(new Error("FILE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", resolve);
        req.on("error", reject);
      }).catch((e: unknown) => {
        if (e instanceof Error && e.message === "FILE_TOO_LARGE") {
          res.set(responseHeaders());
          return res
            .status(413)
            .json(
              apiError(
                "BAD_REQUEST",
                `File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`,
                undefined,
                meta(),
              ),
            );
        }
        throw e;
      });

      // If response already sent (413), bail out
      if (res.headersSent) return;

      const rawBody = Buffer.concat(chunks);

      // ── Parse multipart boundary and extract file + fields ───────────────
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
      if (!boundaryMatch) {
        res.set(responseHeaders());
        return res.status(400).json(apiError("BAD_REQUEST", "Missing multipart boundary", undefined, meta()));
      }
      const boundary = boundaryMatch[1] ?? boundaryMatch[2];
      const boundaryBuffer = Buffer.from(`--${boundary}`);

      // Split body by boundary
      const parts = splitByBoundary(rawBody, boundaryBuffer);

      let fileBuffer: Buffer | null = null;
      let fileName = "";
      let fileMimeType = "application/octet-stream";
      const fields: Record<string, string> = {};

      for (const part of parts) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;
        const headerSection = part.subarray(0, headerEnd).toString("utf-8");
        const body = part.subarray(headerEnd + 4);

        // Remove trailing \r\n from body
        const bodyTrimmed =
          body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a
            ? body.subarray(0, body.length - 2)
            : body;

        const dispositionMatch = headerSection.match(
          /Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i,
        );
        if (!dispositionMatch) continue;

        const fieldName = dispositionMatch[1];
        const fieldFilename = dispositionMatch[2];

        if (fieldFilename !== undefined && fieldFilename !== "") {
          // This is a file field
          fileBuffer = Buffer.from(bodyTrimmed);
          fileName = fieldFilename;
          const ctMatch = headerSection.match(/Content-Type:\s*(\S+)/i);
          fileMimeType = ctMatch?.[1] ?? "application/octet-stream";
        } else {
          // Regular form field
          fields[fieldName] = bodyTrimmed.toString("utf-8");
        }
      }

      if (!fileBuffer || !fileName) {
        res.set(responseHeaders());
        return res.status(400).json(apiError("BAD_REQUEST", "No file provided in the request", undefined, meta()));
      }

      if (!ALLOWED_MIME_TYPES.has(fileMimeType)) {
        res.set(responseHeaders());
        return res
          .status(400)
          .json(apiError("BAD_REQUEST", `File type '${fileMimeType}' is not allowed`, undefined, meta()));
      }

      // ── Forward to ERPNext upload API ────────────────────────────────────
      const erpFormData = new FormData();
      erpFormData.append("file", new Blob([fileBuffer], { type: fileMimeType }), fileName);

      // Attach to a specific doctype/name if provided
      const doctype = fields["doctype"] ?? fields["attached_to_doctype"];
      const docname = fields["docname"] ?? fields["attached_to_name"];
      const isPrivate = fields["is_private"] ?? "1";

      if (doctype) erpFormData.append("doctype", doctype);
      if (docname) erpFormData.append("docname", docname);
      erpFormData.append("is_private", isPrivate);

      const erpHeaders: Record<string, string> = {};
      if (session.erpnextSid && session.erpnextSid !== "dev-local-session") {
        erpHeaders["Cookie"] = `sid=${session.erpnextSid}`;
      } else {
        const apiKey = process.env.ERPNEXT_API_KEY;
        const apiSecret = process.env.ERPNEXT_API_SECRET;
        if (apiKey && apiSecret) {
          erpHeaders["Authorization"] = `token ${apiKey}:${apiSecret}`;
        }
      }
      erpHeaders[ACCOUNT_HEADER] = session.accountId;

      const erpRes = await fetch(`${ERPNEXT_URL}/api/method/upload_file`, {
        method: "POST",
        headers: erpHeaders,
        body: erpFormData,
        signal: AbortSignal.timeout(30_000),
      });

      if (!erpRes.ok) {
        const errBody = await erpRes.text().catch(() => "");
        logger.error("ERPNext upload failed", {
          status: erpRes.status,
          body: errBody.slice(0, 500),
          accountId: session.accountId,
        });
        res.set(responseHeaders());
        return res.status(502).json(apiError("ERP_ERROR", "File upload to ERP failed", undefined, meta()));
      }

      const erpJson = (await erpRes.json()) as {
        message?: { file_url?: string; name?: string; [k: string]: unknown };
      };

      void logAudit({
        accountId: session.accountId,
        userId: session.userId,
        action: "erp.file.upload",
        resource: doctype ?? "File",
        resourceId: docname ?? fileName,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        severity: "info",
        outcome: "success",
        metadata: { fileName, mimeType: fileMimeType, size: fileBuffer.length },
      });

      res.set(responseHeaders());
      return res.json(
        apiSuccess(
          {
            file_url: erpJson.message?.file_url ?? null,
            file_name: erpJson.message?.name ?? fileName,
          },
          meta(),
        ),
      );
    } catch (error) {
      Sentry.captureException(error, { extra: { request_id: requestId } });
      logger.error("Upload route error", { error: error instanceof Error ? error.message : String(error) });
      res.set({ "X-Response-Time": `${Date.now() - start}ms` });
      return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
    }
  },
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function splitByBoundary(buffer: Buffer, boundary: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;

  while (start < buffer.length) {
    const idx = buffer.indexOf(boundary, start);
    if (idx === -1) break;

    if (start > 0) {
      // The part is everything between the previous boundary and this one
      parts.push(buffer.subarray(start, idx));
    }

    start = idx + boundary.length;
    // Skip the CRLF or -- after the boundary
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) {
      // Final boundary (--boundary--)
      break;
    }
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) {
      start += 2;
    }
  }

  return parts;
}

export default router;
