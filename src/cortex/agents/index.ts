/**
 * Cortex agents index — loads every agent module at import time so they
 * register themselves with the registry + the events processor dispatch
 * table. Anything that needs to "boot" the Cortex should import this file.
 *
 * Order matters only for collision detection — if two agents register the
 * same id the registry throws on the second registration. Loading the
 * conversation agent first keeps existing import behaviour stable, then we
 * load the specialists in alphabetical order so the dispatch table fills
 * deterministically.
 */

// Load order: conversation first (it was the only v1.0 agent and other
// modules already import it directly), then the v6.0 specialists in
// alphabetical order. Each side-effect import triggers registerAgent and,
// where applicable, registerEventHandler in the module body.
//
// We do not re-export the agent definitions here because the engine looks
// them up by id via the registry — there is no need for typed re-exports.

import "./conversation.js";
import "./router.js";
import "./extraction/invoice.js";
import "./finance/journal.js";
import "./finance/payment.js";
import "./finance/reconcile.js";
import "./comms/notification.js";
