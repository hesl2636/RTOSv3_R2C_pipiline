/**
 * Read an already built bundle-Release asset directory (#74 §6, #75 §8.3).
 *
 * Publishing never rebuilds: the zip, IR and payloads are exactly the bytes
 * the build produced. This module is the publish gate — it proves the
 * directory is self-consistent, that the zip manifest matches the IR and tag,
 * and that every payload was projected with canonical options — before
 * `release.mjs --publish --out` makes the first remote call.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readZip } from '../../assembler/zip.js';
import { compareCodePoints } from '../../core/code-point.js';
import { inflateRaw } from '../../core/node/inflate.js';
import { sha256Hex } from '../../core/node/sha256.js';
import { isValidVersion } from '../../core/semver.js';
import { canonicalInputOptions } from '../../projection/options.js';
import { getProjection } from '../../projection/registry.js';
import { readPayloadArchive } from '../../installer/release-payload.js';
import { IR_ASSET, bundleTag, isValidBundleId } from '../../installer/release-tags.js';
import { verifySums } from '../../installer/release-source.js';
import { IR_SCHEMA } from '../../ir/schema.js';

const SUMS_ASSET = 'SHA256SUMS.txt';

export function readBuiltRelease(dir) {
  const failures = [];
  const fail = (message) => {
    failures.push(message);
    return { ok: false, failures, notes: [], plan: null, assets: null };
  };
  if (!existsSync(dir)) return fail(`RELEASE_ASSET_SET_MISMATCH: ${dir} does not exist`);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return fail(`RELEASE_ASSET_SET_MISMATCH: ${dir} is unreadable: ${error.message}`);
  }
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(compareCodePoints);
  if (names.length === 0) return fail(`RELEASE_ASSET_SET_MISMATCH: ${dir} holds no assets`);
  if (!names.includes(SUMS_ASSET)) return fail(`RELEASE_ASSET_SET_MISMATCH: ${SUMS_ASSET} is missing`);
  if (!names.includes(IR_ASSET)) return fail(`RELEASE_ASSET_SET_MISMATCH: ${IR_ASSET} is missing`);

  let ir;
  try {
    ir = JSON.parse(readFileSync(join(dir, IR_ASSET), 'utf8'));
  } catch (error) {
    return fail(`RELEASE_PAYLOAD_INVALID: ${IR_ASSET} is not valid JSON: ${error.message}`);
  }
  const id = ir?.id;
  const version = ir?.version;
  if (ir?.schema !== IR_SCHEMA) {
    return fail(`RELEASE_IR_MISMATCH: ${IR_ASSET} schema is ${String(ir?.schema)} (expected ${IR_SCHEMA})`);
  }
  if (!isValidBundleId(id)) return fail(`RELEASE_TAG_MISMATCH: ${IR_ASSET} id ${String(id)} is not a bundle id`);
  if (!isValidVersion(version) || String(version).includes('+')) {
    return fail(`RELEASE_VERSION_MISMATCH: ${IR_ASSET} version ${String(version)} is not a semver without build metadata`);
  }
  const zipName = `bundle-${id}-v${version}.zip`;
  if (!names.includes(zipName)) return fail(`RELEASE_ASSET_SET_MISMATCH: ${zipName} is missing`);

  const assets = [];
  for (const name of names) {
    if (name === SUMS_ASSET) continue;
    const data = readFileSync(join(dir, name));
    assets.push({ name, data, size: data.length, sha256: sha256Hex(data) });
  }
  const sumsBytes = readFileSync(join(dir, SUMS_ASSET));
  const sums = verifySums(sumsBytes, assets, { requireAll: true });
  if (!sums.ok) {
    for (const failure of sums.failures) failures.push(failure);
    return { ok: false, failures, notes: [], plan: null, assets: null };
  }
  const diskNames = names.filter((name) => name !== SUMS_ASSET);
  const sumsNames = [...assets.map((asset) => asset.name)].sort(compareCodePoints);
  if (JSON.stringify(diskNames) !== JSON.stringify(sumsNames)) {
    return fail(`RELEASE_ASSET_SET_MISMATCH: ${SUMS_ASSET} does not cover exactly [${diskNames.join(', ')}]`);
  }
  // Identity: a published tag must describe the zip bytes it ships. Open the
  // archive and compare its own manifest with the IR (and the IR source
  // digest when present) before any remote call.
  const zipAsset = assets.find((asset) => asset.name === zipName);
  const archive = readZip(new Uint8Array(zipAsset.data), { inflateRaw });
  const archiveError = archive.diagnostics.find((item) => item.severity === 'error');
  if (archiveError !== undefined) {
    return fail(`RELEASE_IR_MISMATCH: ${zipName} is not a readable bundle: ${archiveError.message}`);
  }
  const zipManifestEntry = archive.entries.get('bundle.json');
  if (zipManifestEntry === undefined) {
    return fail(`RELEASE_IR_MISMATCH: ${zipName} has no bundle.json`);
  }
  let zipManifest;
  try {
    zipManifest = JSON.parse(Buffer.from(zipManifestEntry.data).toString('utf8'));
  } catch (error) {
    return fail(`RELEASE_IR_MISMATCH: ${zipName} bundle.json is not JSON: ${error.message}`);
  }
  if (zipManifest?.id !== id || zipManifest?.version !== version) {
    return fail(`RELEASE_TAG_MISMATCH: ${zipName} carries ${String(zipManifest?.id)}@${String(zipManifest?.version)}, the release is ${id}@${version}`);
  }
  const irManifestSha = ir?.source?.manifest?.sha256;
  if (typeof irManifestSha === 'string' && sha256Hex(zipManifestEntry.data) !== irManifestSha) {
    return fail(`RELEASE_IR_MISMATCH: ${zipName} bundle.json digest does not match IR source.manifest.sha256`);
  }

  // Only a canonical build may become a Release (#74 §3.4, #75 §6.5). The
  // payload manifest records the options it was projected with; a custom
  // selection records the concrete arrays instead of the canonical nulls.
  for (const asset of assets) {
    const projectionId = asset.name.startsWith('hm2b-payload-') ? 'runner'
      : asset.name.startsWith('agent-native-') ? 'agent-native' : null;
    if (projectionId === null) continue;
    const payload = readPayloadArchive(asset.data);
    if (payload.manifest === null) {
      return fail(`RELEASE_PAYLOAD_INVALID: ${asset.name} has no readable manifest.json`);
    }
    if (payload.manifest.bundle?.id !== id || payload.manifest.bundle?.version !== version) {
      return fail(`RELEASE_TAG_MISMATCH: ${asset.name} carries ${String(payload.manifest.bundle?.id)}@${String(payload.manifest.bundle?.version)}, the release is ${id}@${version}`);
    }
    const canonical = canonicalInputOptions(projectionId, getProjection(projectionId));
    if (JSON.stringify(payload.manifest.options) !== JSON.stringify(canonical)) {
      return fail(`WEB_PUBLISH_NOT_CANONICAL: ${asset.name} was built with custom projection options; only a canonical build can be published`);
    }
  }

  // The publish state machine verifies remote SHA256SUMS.txt again, so the
  // sums file travels with the assets (it is never listed inside itself).
  assets.push({ name: SUMS_ASSET, data: sumsBytes, size: sumsBytes.length, sha256: sha256Hex(sumsBytes) });
  assets.sort((left, right) => compareCodePoints(left.name, right.name));

  return {
    ok: true,
    failures: [],
    notes: [],
    plan: {
      tag: bundleTag(id, version),
      bundleId: id,
      version,
      name: `${id} v${version}`,
      makeLatest: false,
      prerelease: false,
      draft: true,
      assets: assets
        .map((asset) => ({ name: asset.name, size: asset.size, sha256: asset.sha256 }))
        .sort((left, right) => compareCodePoints(left.name, right.name)),
    },
    assets,
  };
}

