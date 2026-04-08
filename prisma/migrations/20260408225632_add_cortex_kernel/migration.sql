-- Cortex AI Kernel — Phase 1 Foundation
-- Adds 5 tables that layer the AI agent system on top of the existing Prisma stack.
-- Every table is scoped by account_id to preserve the existing tenant boundary.

-- ─── cortex_events ────────────────────────────────────────────────────────────
-- Immutable append-only event log. Every business mutation writes one row,
-- the orchestrator picks them up via the cortex BullMQ queue.
CREATE TABLE "cortex_events" (
  "id"           TEXT NOT NULL,
  "account_id"   TEXT NOT NULL,
  "event_type"   TEXT NOT NULL,
  "source"       TEXT NOT NULL,
  "data"         JSONB NOT NULL,
  "user_id"      TEXT,
  "agent_id"     TEXT,
  "trace_id"     TEXT NOT NULL,
  "processed"    BOOLEAN NOT NULL DEFAULT false,
  "processed_at" TIMESTAMP(3),
  "processed_by" TEXT,
  "result"       JSONB,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cortex_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cortex_events_account_id_event_type_created_at_idx"
  ON "cortex_events" ("account_id", "event_type", "created_at");
CREATE INDEX "cortex_events_account_id_processed_idx"
  ON "cortex_events" ("account_id", "processed");
CREATE INDEX "cortex_events_trace_id_idx"
  ON "cortex_events" ("trace_id");

ALTER TABLE "cortex_events"
  ADD CONSTRAINT "cortex_events_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── cortex_conversations ─────────────────────────────────────────────────────
-- Persistent multi-turn Bridge AI conversations. Distinct from the
-- Redis-backed history of the legacy /api/ai/chat — these survive restarts.
CREATE TABLE "cortex_conversations" (
  "id"             TEXT NOT NULL,
  "account_id"     TEXT NOT NULL,
  "user_id"        TEXT NOT NULL,
  "title"          TEXT,
  "messages"       JSONB NOT NULL DEFAULT '[]',
  "last_agent_id"  TEXT,
  "last_trace_id"  TEXT,
  "archived"       BOOLEAN NOT NULL DEFAULT false,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "cortex_conversations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cortex_conversations_account_id_user_id_updated_at_idx"
  ON "cortex_conversations" ("account_id", "user_id", "updated_at");
CREATE INDEX "cortex_conversations_account_id_archived_idx"
  ON "cortex_conversations" ("account_id", "archived");

ALTER TABLE "cortex_conversations"
  ADD CONSTRAINT "cortex_conversations_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── cortex_execution_logs ────────────────────────────────────────────────────
-- One row per agent run. Inputs, model + token usage, latency, status.
CREATE TABLE "cortex_execution_logs" (
  "id"                TEXT NOT NULL,
  "account_id"        TEXT NOT NULL,
  "agent_id"          TEXT NOT NULL,
  "trace_id"          TEXT NOT NULL,
  "trigger_event_id"  TEXT,
  "status"            TEXT NOT NULL,
  "model"             TEXT NOT NULL,
  "input_tokens"      INTEGER NOT NULL,
  "output_tokens"     INTEGER NOT NULL,
  "cost_usd"          DOUBLE PRECISION NOT NULL,
  "latency_ms"        INTEGER NOT NULL,
  "iterations"        INTEGER NOT NULL,
  "tool_call_count"   INTEGER NOT NULL,
  "tool_call_errors"  INTEGER NOT NULL,
  "output"            TEXT,
  "error_message"     TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cortex_execution_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cortex_execution_logs_account_id_agent_id_created_at_idx"
  ON "cortex_execution_logs" ("account_id", "agent_id", "created_at");
CREATE INDEX "cortex_execution_logs_trace_id_idx"
  ON "cortex_execution_logs" ("trace_id");

ALTER TABLE "cortex_execution_logs"
  ADD CONSTRAINT "cortex_execution_logs_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── cortex_approval_requests ─────────────────────────────────────────────────
-- Pending actions awaiting human approval (financial impact > agent limit,
-- autonomy < 3, etc).
CREATE TABLE "cortex_approval_requests" (
  "id"                TEXT NOT NULL,
  "account_id"        TEXT NOT NULL,
  "title"             TEXT NOT NULL,
  "description"       TEXT NOT NULL,
  "approval_type"     TEXT NOT NULL,
  "priority"          TEXT NOT NULL DEFAULT 'normal',
  "status"            TEXT NOT NULL DEFAULT 'pending',
  "agent_id"          TEXT NOT NULL,
  "trace_id"          TEXT NOT NULL,
  "ai_recommendation" TEXT,
  "ai_reasoning"      TEXT,
  "ai_confidence"     DOUBLE PRECISION,
  "pending_action"    JSONB,
  "approver_user_ids" TEXT[],
  "approver_roles"    TEXT[],
  "approved_by"       TEXT,
  "approved_at"       TIMESTAMP(3),
  "rejected_by"       TEXT,
  "rejected_at"       TIMESTAMP(3),
  "rejection_reason"  TEXT,
  "expires_at"        TIMESTAMP(3),
  "related_doc_type"  TEXT,
  "related_doc_id"    TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "cortex_approval_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cortex_approval_requests_account_id_status_created_at_idx"
  ON "cortex_approval_requests" ("account_id", "status", "created_at");
CREATE INDEX "cortex_approval_requests_account_id_approval_type_status_idx"
  ON "cortex_approval_requests" ("account_id", "approval_type", "status");

ALTER TABLE "cortex_approval_requests"
  ADD CONSTRAINT "cortex_approval_requests_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── cortex_memory ────────────────────────────────────────────────────────────
-- Per-tenant learning store. Business rules, recurring patterns, preferences.
CREATE TABLE "cortex_memory" (
  "id"                  TEXT NOT NULL,
  "account_id"          TEXT NOT NULL,
  "memory_type"         TEXT NOT NULL,
  "key"                 TEXT NOT NULL,
  "value"               JSONB NOT NULL,
  "confidence"          DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "learned_from_events" TEXT[],
  "learned_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_reinforced_at"  TIMESTAMP(3),
  "reinforcement_count" INTEGER NOT NULL DEFAULT 1,
  "is_active"           BOOLEAN NOT NULL DEFAULT true,
  "expires_at"          TIMESTAMP(3),

  CONSTRAINT "cortex_memory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cortex_memory_account_id_memory_type_key_key"
  ON "cortex_memory" ("account_id", "memory_type", "key");
CREATE INDEX "cortex_memory_account_id_memory_type_idx"
  ON "cortex_memory" ("account_id", "memory_type");
CREATE INDEX "cortex_memory_account_id_is_active_idx"
  ON "cortex_memory" ("account_id", "is_active");

ALTER TABLE "cortex_memory"
  ADD CONSTRAINT "cortex_memory_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
