/**
 * Tag and asset-name contract of the two release channels (#107, decision #74
 * §2/§3).
 *
 * `bundle-<id>-v<version>` is the per-bundle channel; `v<engine>` is the
 * legacy engine channel. The namespaces never overlap and a tag name is never
 * reused. Parsing always anchors on the caller's known id — never
 * `split('-v')`, never guesses an id, never accepts build metadata.
 *
 * This module is pure (core/ + ir/ imports only) and ships inside the
 * framework archive, so the installer and the web publisher can use it
 * without `scripts/`.
 */
import { compareCodePoints } from '../core/code-point.js';
import { isValidVersion } from '../core/semver.js';
import { IR_FILENAME } from '../ir/schema.js';

export const IR_ASSET = IR_FILENAME;
export const INSTALL_ASSET = 'install.mjs';
export const SUMS_ASSET = 'SHA256SUMS.txt';

export const BUNDLE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BUNDLE_ID_MAX = 40;
/** Strict semver, no build metadata (decision #74 §2.1). */
export const BUNDLE_TAG_VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?`;

const BUNDLE_TAG_TEMPLATE = String.raw`^bundle-<ID>-v(${BUNDLE_TAG_VERSION})$`;
const LEGACY_TAG_PATTERN = new RegExp(String.raw`^v(${BUNDLE_TAG_VERSION})$`);

export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isValidBundleId(id) {
  return typeof id === 'string' && BUNDLE_ID_RE.test(id) && id.length <= BUNDLE_ID_MAX;
}

/** The only bundle tag shape; parsing always anchors on the known id. */
export function bundleTag(id, version) {
  return `bundle-${id}-v${version}`;
}

/**
 * Parse `bundle-<id>-v<version>` from right to left with an anchored regex
 * built from the known id (#74 §2.1). Returns `{id, version}` or null.
 */
export function parseBundleTag(tag, id) {
  if (typeof tag !== 'string' || !isValidBundleId(id)) return null;
  if (tag.includes('+')) return null;
  const pattern = new RegExp(BUNDLE_TAG_TEMPLATE.replace('<ID>', escapeRegExp(id)));
  const match = pattern.exec(tag);
  if (match === null) return null;
  if (!isValidVersion(match[1])) return null;
  return { id, version: match[1] };
}

/** `v<engine>` is the legacy channel; the two namespaces are disjoint. */
export function isLegacyEngineTag(tag) {
  if (typeof tag !== 'string' || tag.includes('+')) return false;
  const match = LEGACY_TAG_PATTERN.exec(tag);
  return match !== null && isValidVersion(match[1]);
}

/**
 * The exact asset names of one bundle Release, sorted by code point.
 * `allowed` is `ir.requires.projections` (default: both projections).
 */
export function bundleAssetNames({ id, version, allowed, engineVersion, frameworkVersion }) {
  const names = [
    INSTALL_ASSET,
    IR_ASSET,
    `bundle-${id}-v${version}.zip`,
    `r2c-framework-${frameworkVersion}.tgz`,
  ];
  if (allowed.includes('r2c')) {
    names.push(`r2c-payload-${id}-v${version}.tgz`, `r2c-engine-${engineVersion}.tgz`);
  }
  if (allowed.includes('agent-native')) names.push(`agent-native-${id}-v${version}.tgz`);
  names.push(SUMS_ASSET);
  return [...new Set(names)].sort(compareCodePoints);
}

/** The four legacy `v<E>` asset names, for cross-channel isolation checks. */
export function legacyAssetNames(engineVersion) {
  return [
    INSTALL_ASSET,
    SUMS_ASSET,
    `r2c-engine-${engineVersion}.tgz`,
    `r2c-payload-${engineVersion}.tgz`,
  ].sort(compareCodePoints);
}
