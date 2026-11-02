/**
 * Shared JSON-document checks for bundle JSON: parse, canonical bytes, and a
 * usable value (decision #67 §7.2, S2).
 *
 * Strict parsing runs first. A document that only violates the canonical shape
 * (comments, trailing commas) is repaired so the parsed value stays available:
 * `BUNDLE_JSON_NOT_CANONICAL` never suppresses derived checks. Anything the
 * repair cannot rescue is `BUNDLE_JSON_PARSE` and stops that document's checks.
 */
import { canonicalJson, firstDifferenceOffset } from '../../core/canonical-json.js';
import { repairJson, scanJson } from '../json-scan.js';

function parseErrorLine(error, text) {
  const message = error instanceof Error ? error.message : String(error);
  const match = /line (\d+)/.exec(message);
  if (match !== null) return Number.parseInt(match[1], 10);
  const position = /position (\d+)/.exec(message);
  if (position !== null) {
    const offset = Number.parseInt(position[1], 10);
    return text.slice(0, offset).split('\n').length;
  }
  return null;
}

function notCanonicalReason(scan) {
  if (scan.duplicates.length > 0) return 'duplicate-key';
  if (scan.comments.length > 0) return 'comment';
  if (scan.trailingCommas.length > 0) return 'trailing-comma';
  return 'bytes';
}

function notCanonicalLine(scan, reason) {
  if (reason === 'duplicate-key') return scan.duplicates[0].line;
  if (reason === 'comment') return scan.comments[0].line;
  if (reason === 'trailing-comma') return scan.trailingCommas[0].line;
  return null;
}

/**
 * First key whose position contradicts `order` (schema writing order).
 * Unknown keys are ignored here: `BUNDLE_UNKNOWN_KEY` owns them.
 */
export function findKeyOrderViolation(value, order) {
  let last = -1;
  for (const key of Object.keys(value)) {
    const position = order.indexOf(key);
    if (position === -1) continue;
    if (position < last) return key;
    last = position;
  }
  return null;
}

/** First line where `key` appears as a JSON member, or `null`. */
export function lineForKey(text, key) {
  const index = text.indexOf(`"${key}"`);
  if (index < 0) return null;
  return text.slice(0, index).split('\n').length;
}

/**
 * Parse `text` into `{ value }`; report and return `null` when unusable.
 *
 * @param {object} context validation context with `fail`
 * @param {string} path archive-relative document path
 * @param {string} text decoded document text
 * @param {{ order?: (value: unknown) => string|null }} [options]
 * @returns {{value: unknown}|null}
 */
export function readJsonDocument(context, path, text, options = {}) {
  const scan = scanJson(text);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    let repaired = false;
    try {
      value = JSON.parse(repairJson(text));
      repaired = true;
    } catch {
      repaired = false;
    }
    if (!repaired) {
      context.fail(path, 'BUNDLE_JSON_PARSE', `${path} is not valid JSON`, {
        line: parseErrorLine(error, text),
        details: { reason: 'syntax' },
      });
      return null;
    }
  }

  const canonical = canonicalJson(value);
  const outOfOrder = typeof options.order === 'function' ? options.order(value) : null;
  if (canonical !== text || outOfOrder !== null) {
    let reason = notCanonicalReason(scan);
    if (reason === 'bytes' && outOfOrder !== null) reason = 'key-order';
    context.fail(path, 'BUNDLE_JSON_NOT_CANONICAL', `${path} is not canonical JSON`, {
      line: outOfOrder !== null ? lineForKey(text, outOfOrder) : notCanonicalLine(scan, reason),
      details: { offset: firstDifferenceOffset(canonical, text), reason },
    });
  }
  return { value };
}
