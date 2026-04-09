-- Cortex Feedback — Phase 2 of the AI-Native ERP overhaul.
-- Captures human ratings, comments, and corrections on Cortex agent decisions
-- so the learning pipeline can promote corrections into per-tenant business
-- rules in cortex_memory.

-- ─── cortex_feedback ──────────────────────────────────────────────────────────
CREATE TABLE "cortex_feedback" (
  "id"                TEXT NOT NULL,
  "account_id"        TEXT NOT NULL,
  "agent_id"          TEXT NOT NULL,
  "trace_id"          TEXT NOT NULL,
  "original_output"   JSONB NOT NULL,
  "feedback_type"     TEXT NOT NULL,
  "corrected_output"  JSONB,
  "rating"            INTEGER,
  "comment"           TEXT,
  "user_id"           TEXT NOT NULL,
  "applied_to_memory" BOOLEAN NOT NULL DEFAULT false,
  "memory_id"         TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cortex_feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cortex_feedback_account_id_agent_id_created_at_idx"
  ON "cortex_feedback" ("account_id", "agent_id", "created_at");
CREATE INDEX "cortex_feedback_account_id_feedback_type_idx"
  ON "cortex_feedback" ("account_id", "feedback_type");
CREATE INDEX "cortex_feedback_trace_id_idx"
  ON "cortex_feedback" ("trace_id");

ALTER TABLE "cortex_feedback"
  ADD CONSTRAINT "cortex_feedback_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
