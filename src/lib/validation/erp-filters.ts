/**
 * ERP filter validation — structural AND content validation.
 *
 * ERPNext filters are arrays of [doctype, field, operator, value] tuples.
 * We validate structure, depth, operators, and value types to prevent
 * injection and DoS via malicious filter payloads.
 */

const MAX_FILTERS = 20;
const MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 3;
const ALLOWED_OPERATORS = new Set([
  "=",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "like",
  "not like",
  "in",
  "not in",
  "is",
  "is not",
  "between",
]);

function checkDepth(value: unknown, currentDepth: number): boolean {
  if (currentDepth > MAX_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.every((item) => checkDepth(item, currentDepth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).every((v) => checkDepth(v, currentDepth + 1));
  }
  return true;
}

function isValidFilterValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value === "string") return value.length <= MAX_STRING_LENGTH;
  if (Array.isArray(value)) return value.length <= 100 && value.every(isValidFilterValue);
  return false;
}

export function validateErpFilters(raw: string | undefined): { ok: boolean; filters: unknown[]; error?: string } {
  if (!raw) return { ok: true, filters: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, filters: [], error: "Invalid JSON in filters parameter" };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, filters: [], error: "Filters must be an array" };
  }

  if (parsed.length > MAX_FILTERS) {
    return { ok: false, filters: [], error: `Too many filters (max ${MAX_FILTERS})` };
  }

  if (!checkDepth(parsed, 0)) {
    return { ok: false, filters: [], error: "Filter nesting too deep" };
  }

  // Validate each filter tuple: [doctype, field, operator, value] or [field, operator, value]
  for (const filter of parsed) {
    if (!Array.isArray(filter)) {
      return { ok: false, filters: [], error: "Each filter must be an array" };
    }
    if (filter.length < 3 || filter.length > 4) {
      return { ok: false, filters: [], error: "Each filter must have 3 or 4 elements" };
    }

    const [doctype, field, operator, value] =
      filter.length === 4 ? filter : [undefined, filter[0], filter[1], filter[2]];

    // Validate field name (alphanumeric + underscore only)
    if (typeof field !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(field)) {
      return { ok: false, filters: [], error: `Invalid field name: ${String(field)}` };
    }

    // Validate operator
    if (typeof operator !== "string" || !ALLOWED_OPERATORS.has(operator.toLowerCase())) {
      return { ok: false, filters: [], error: `Invalid operator: ${String(operator)}` };
    }

    // Validate doctype if present
    if (doctype !== undefined && (typeof doctype !== "string" || !/^[a-zA-Z ]+$/.test(doctype))) {
      return { ok: false, filters: [], error: `Invalid doctype: ${String(doctype)}` };
    }

    // Validate value
    if (!isValidFilterValue(value)) {
      return { ok: false, filters: [], error: "Invalid filter value" };
    }
  }

  return { ok: true, filters: parsed };
}
