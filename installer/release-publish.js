/**
 * Publish state machine for per-bundle Releases (#107, decision #74 §6/§7).
 *
 * PRECHECK → DRAFT_CREATED → UPLOADING → VERIFYING → PUBLISHING → PUBLISHED
 *
 * - The draft is created with `draft: true`, `prerelease: false` and
 *   `make_latest: "false"`; the repository Latest stays with the legacy
 *   channel.
 * - Every asset is uploaded, then re-read: names, sizes and digests must
 *   match the local plan and `SHA256SUMS.txt`, and only then is the release
 *   published (`PATCH draft=false`).
 * - A failure before publish deletes this run's draft and, when this run
 *   created it, the tag. A failure after publish never rewrites the published
 *   assets: it reports "mark prerelease or publish a new patch".
 * - Same-name uploads are never replaced (422 is final unless the bytes are
 *   already identical); published releases are read-only.
 * - The token is only ever in the client's `authorization` header; every
 *   string this module returns is redacted.
 */
import { compareCodePoints } from '../core/code-point.js';
import { sha256Hex } from '../core/node/sha256.js';
import { redactSecret } from './release-auth.js';
import { verifySums } from './release-source.js';
import {
  SUMS_ASSET,
  bundleTag,
  isLegacyEngineTag,
  parseBundleTag,
} from './release-tags.js';

export const PUBLISH_STATES = Object.freeze([
  'PRECHECK',
  'DRAFT_CREATED',
  'UPLOADING',
  'VERIFYING',
  'PUBLISHING',
  'PUBLISHED',
]);

const EMPTY_CLEANUP = Object.freeze({ draftDeleted: false, tagDeleted: false });

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function defaultBody(plan) {
  const lines = [`bundle: ${plan.bundleId}@${plan.version}`, `tag: ${plan.tag}`, 'assets:'];
  for (const asset of plan.assets) lines.push(`  ${asset.sha256}  ${asset.name}`);
  return `${lines.join('\n')}\n`;
}

function errorLine(error) {
  const message = String(error?.message ?? error);
  return /^RELEASE_[A-Z_]+: /.test(message) ? message : `RELEASE_PUBLISH_FAILED: ${message}`;
}

/**
 * @param {{client: {token: string|null, request: Function}, repo: string,
 *          plan: object, assets: Array<{name: string, data: Buffer|Uint8Array}>,
 *          targetCommitish?: string|null, releaseBody?: string|null}} input
 * @returns {Promise<object>} `{ok, state, published, tag, releaseId,
 *   transitions, trace, failures, notes, cleanup, recovery}`
 */
export async function publishBundle({
  client,
  repo,
  plan,
  assets,
  targetCommitish = null,
  releaseBody = null,
} = {}) {
  if (client === null || typeof client !== 'object' || typeof client.request !== 'function') {
    throw new TypeError('a GitHub client ({base, token, fetch}) is required');
  }
  const secret = typeof client.token === 'string' && client.token !== '' ? client.token : null;
  const redact = (text) => (secret === null ? String(text) : redactSecret(text, secret));

  const trace = [];
  const notes = [];
  const failures = [];
  const transitions = [];
  let published = false;
  let release = null;
  let releaseId = null;
  let preExistingTag = true;
  let state = 'FAILED';

  const call = async (phase, method, target, options = undefined) => {
    const response = await client.request(method, target, options);
    trace.push({ phase, method, status: response.status, url: redact(response.url ?? target) });
    return response;
  };

  const finish = (overrides = {}) => ({
    ok: overrides.ok === true,
    state: overrides.state ?? state,
    published: overrides.published ?? published,
    tag: typeof plan?.tag === 'string' ? plan.tag : null,
    releaseId: overrides.releaseId ?? releaseId,
    transitions: [...transitions],
    trace,
    failures: failures.map(redact),
    notes: notes.map(redact),
    cleanup: overrides.cleanup ?? { ...EMPTY_CLEANUP },
    recovery: overrides.recovery ?? null,
  });

  async function rollback() {
    const cleanup = { ...EMPTY_CLEANUP };
    if (releaseId !== null) {
      const deleted = await call('FAILED', 'DELETE', `/repos/${repo}/releases/${releaseId}`);
      if (deleted.status === 204 || deleted.status === 404) cleanup.draftDeleted = true;
      else notes.push(`could not delete draft release ${releaseId}: HTTP ${deleted.status}`);
    }
    if (!preExistingTag && typeof plan?.tag === 'string') {
      const refPath = `/repos/${repo}/git/ref/tags/${encodeURIComponent(plan.tag)}`;
      const ref = await call('FAILED', 'GET', refPath);
      if (ref.status === 200) {
        const deleted = await call('FAILED', 'DELETE', `/repos/${repo}/git/refs/tags/${encodeURIComponent(plan.tag)}`);
        if (deleted.status === 204) cleanup.tagDeleted = true;
        else notes.push(`could not delete tag ${plan.tag}: HTTP ${deleted.status}`);
      } else if (ref.status !== 404) {
        notes.push(`could not confirm tag ${plan.tag}: HTTP ${ref.status}`);
      }
    }
    return cleanup;
  }

  async function failBeforePublish() {
    const cleanup = await rollback();
    notes.push('nothing was published; the draft was deleted and the version can be reused');
    return finish({ ok: false, state: 'FAILED', published: false, cleanup, recovery: 'retry' });
  }

  // ---- PRECHECK ----------------------------------------------------------
  transitions.push('PRECHECK');
  if (secret === null) {
    failures.push('RELEASE_AUTH_REQUIRED: publishing requires GH_TOKEN with Contents: Write; install and preview are unaffected');
    return finish({ ok: false, state: 'FAILED' });
  }
  if (plan === null || typeof plan !== 'object' || typeof plan.tag !== 'string') {
    failures.push('RELEASE_TAG_MISMATCH: the plan has no tag');
    return finish({ ok: false, state: 'FAILED' });
  }
  if (isLegacyEngineTag(plan.tag)) {
    failures.push(`RELEASE_OPTION_CONFLICT: ${plan.tag} belongs to the legacy v<engine> channel; bundle releases use bundle-<id>-v<version>`);
    return finish({ ok: false, state: 'FAILED' });
  }
  const parsedTag = parseBundleTag(plan.tag, plan.bundleId);
  if (parsedTag === null || parsedTag.version !== plan.version) {
    failures.push(`RELEASE_TAG_MISMATCH: ${plan.tag} is not ${String(plan.bundleId)}@${String(plan.version)} without build metadata`);
    return finish({ ok: false, state: 'FAILED' });
  }
  if (plan.tag !== bundleTag(plan.bundleId, plan.version)) {
    failures.push(`RELEASE_TAG_MISMATCH: ${plan.tag} does not match ${String(plan.bundleId)}@${String(plan.version)}`);
    return finish({ ok: false, state: 'FAILED' });
  }
  if (plan.draft !== true) {
    failures.push('RELEASE_OPTION_CONFLICT: the plan must describe a draft release');
    return finish({ ok: false, state: 'FAILED' });
  }

  const local = new Map();
  const planned = new Map();
  if (!Array.isArray(plan.assets) || plan.assets.length === 0) {
    failures.push('RELEASE_ASSET_SET_MISMATCH: the plan has no assets');
    return finish({ ok: false, state: 'FAILED' });
  }
  for (const asset of plan.assets) planned.set(asset.name, asset);
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (asset === null || typeof asset?.name !== 'string') continue;
    const data = Buffer.isBuffer(asset.data) ? asset.data : Buffer.from(asset.data ?? '');
    local.set(asset.name, {
      name: asset.name,
      data,
      size: data.length,
      sha256: sha256Hex(data),
    });
  }
  const plannedNames = [...planned.keys()].sort(compareCodePoints);
  const localNames = [...local.keys()].sort(compareCodePoints);
  if (!sameList(plannedNames, localNames)) {
    failures.push(`RELEASE_ASSET_SET_MISMATCH: assets are [${localNames.join(', ')}], the plan expects [${plannedNames.join(', ')}]`);
  }
  for (const name of plannedNames) {
    const expected = planned.get(name);
    const actual = local.get(name);
    if (actual === undefined) continue;
    if (Number(expected.size) !== actual.size) {
      failures.push(`RELEASE_ASSET_SET_MISMATCH: ${name} is ${actual.size} bytes, the plan says ${expected.size}`);
    }
    if (expected.sha256 !== actual.sha256) {
      failures.push(`RELEASE_ASSET_SET_MISMATCH: ${name} has sha256 ${actual.sha256}, the plan says ${expected.sha256}`);
    }
  }
  if (!local.has(SUMS_ASSET)) {
    failures.push(`RELEASE_ASSET_SET_MISMATCH: ${SUMS_ASSET} is missing`);
  } else {
    const sums = verifySums(local.get(SUMS_ASSET).data, [...local.values()].filter((asset) => asset.name !== SUMS_ASSET), {
      requireAll: true,
    });
    failures.push(...sums.failures);
  }
  if (failures.length > 0) {
    notes.push('precheck failed locally; no request was made');
    return finish({ ok: false, state: 'FAILED' });
  }

  const tagPath = `/repos/${repo}/releases/tags/${encodeURIComponent(plan.tag)}`;
  try {
    // ---- existing release / tag ownership --------------------------------
    const existing = await call('PRECHECK', 'GET', tagPath);
    if (existing.status === 200 && existing.data?.draft !== true) {
      published = true;
      releaseId = typeof existing.data?.id === 'number' ? existing.data.id : null;
      failures.push(`RELEASE_TAG_CONFLICT: ${plan.tag} is already published; release versions are immutable (publish ${String(plan.version)} with a new patch version instead)`);
      notes.push('nothing was uploaded, patched or deleted');
      return finish({ ok: false, state: 'ALREADY_PUBLISHED', published: true, releaseId, recovery: 'new-patch' });
    }
    if (existing.status === 200) {
      release = existing.data;
      releaseId = typeof release.id === 'number' ? release.id : null;
      preExistingTag = true;
      notes.push(`resuming the existing draft ${plan.tag}`);
    } else if (existing.status === 404) {
      const ref = await call('PRECHECK', 'GET', `/repos/${repo}/git/ref/tags/${encodeURIComponent(plan.tag)}`);
      if (ref.status === 200) {
        preExistingTag = true;
        const sha = typeof ref.data?.object?.sha === 'string' ? ref.data.object.sha : null;
        const type = ref.data?.object?.type;
        if (targetCommitish !== null && type === 'commit' && sha !== null && sha !== targetCommitish) {
          failures.push(`RELEASE_TAG_CONFLICT: tag ${plan.tag} already points at ${sha}, not ${targetCommitish}; tags are never force-updated`);
          return finish({ ok: false, state: 'FAILED' });
        }
      } else if (ref.status === 404) {
        preExistingTag = false;
      } else {
        failures.push(errorLine(new Error(`${tagPath}: HTTP ${ref.status}`)));
        return finish({ ok: false, state: 'FAILED' });
      }

      const body = {
        tag_name: plan.tag,
        name: typeof plan.name === 'string' && plan.name !== '' ? plan.name : plan.tag,
        body: redact(releaseBody ?? defaultBody(plan)),
        draft: true,
        prerelease: false,
        make_latest: 'false',
      };
      if (targetCommitish !== null) body.target_commitish = targetCommitish;
      const created = await call('PRECHECK', 'POST', `/repos/${repo}/releases`, { body });
      if (!created.ok) {
        if (created.status === 422) {
          failures.push(`RELEASE_TAG_CONFLICT: ${plan.tag} already exists; tags and releases are never force-updated`);
        } else {
          failures.push(errorLine(new Error(`create draft ${plan.tag}: HTTP ${created.status}`)));
        }
        return finish({ ok: false, state: 'FAILED' });
      }
      release = created.data;
      releaseId = typeof release?.id === 'number' ? release.id : null;
      if (releaseId === null) {
        failures.push('RELEASE_PUBLISH_FAILED: the draft response has no release id');
        return finish({ ok: false, state: 'FAILED' });
      }
    } else {
      failures.push(errorLine(new Error(`lookup ${plan.tag}: HTTP ${existing.status}`)));
      return finish({ ok: false, state: 'FAILED' });
    }
    transitions.push('DRAFT_CREATED');

    const uploadBase = typeof release.upload_url === 'string'
      ? release.upload_url.replace(/\{.*\}$/, '')
      : '';
    if (uploadBase === '') {
      failures.push('RELEASE_PUBLISH_FAILED: the draft response has no upload_url');
      return await failBeforePublish();
    }

    // ---- UPLOADING -------------------------------------------------------
    transitions.push('UPLOADING');
    for (const asset of [...local.values()].sort((left, right) => compareCodePoints(left.name, right.name))) {
      const separator = uploadBase.includes('?') ? '&' : '?';
      const target = `${uploadBase}${separator}name=${encodeURIComponent(asset.name)}`;
      const uploaded = await call('UPLOADING', 'POST', target, {
        body: asset.data,
        contentType: 'application/octet-stream',
      });
      if (uploaded.ok) continue;
      if (uploaded.status === 422) {
        const listed = await call('UPLOADING', 'GET', `/repos/${repo}/releases/${releaseId}/assets?per_page=100`);
        const found = listed.ok && Array.isArray(listed.data)
          ? listed.data.find((entry) => entry?.name === asset.name)
          : undefined;
        if (found !== undefined && Number(found.size) === asset.size) {
          notes.push(`${asset.name} was already uploaded with identical bytes`);
          continue;
        }
        failures.push(`RELEASE_ASSET_IMMUTABLE: ${asset.name} already exists on ${plan.tag} with different bytes; assets are never replaced`);
        return await failBeforePublish();
      }
      failures.push(`RELEASE_PUBLISH_FAILED: upload of ${asset.name} failed: HTTP ${uploaded.status}`);
      return await failBeforePublish();
    }

    // ---- VERIFYING -------------------------------------------------------
    transitions.push('VERIFYING');
    const listed = await call('VERIFYING', 'GET', `/repos/${repo}/releases/${releaseId}/assets?per_page=100`);
    if (!listed.ok || !Array.isArray(listed.data)) {
      failures.push(`RELEASE_DRAFT_VERIFY_FAILED: cannot list the draft assets (HTTP ${listed.status})`);
      return await failBeforePublish();
    }
    const remote = listed.data;
    const remoteNames = remote.map((entry) => entry?.name).filter((name) => typeof name === 'string').sort(compareCodePoints);
    if (!sameList(remoteNames, localNames)) {
      failures.push(`RELEASE_ASSET_SET_MISMATCH: draft assets are [${remoteNames.join(', ')}], expected [${localNames.join(', ')}]`);
      return await failBeforePublish();
    }

    const downloadRemote = async (entry) => {
      const target = typeof entry.url === 'string' && entry.url !== ''
        ? entry.url
        : `/repos/${repo}/releases/assets/${entry.id}`;
      const response = await call('VERIFYING', 'GET', target, { accept: 'application/octet-stream', parse: 'bytes' });
      if (!response.ok) throw new Error(`download ${entry.name}: HTTP ${response.status}`);
      return Buffer.from(response.data);
    };

    for (const asset of [...local.values()].sort((left, right) => compareCodePoints(left.name, right.name))) {
      const entry = remote.find((candidate) => candidate?.name === asset.name);
      if (entry === undefined) {
        failures.push(`RELEASE_DRAFT_VERIFY_FAILED: ${asset.name} is missing from the draft`);
        return await failBeforePublish();
      }
      if (Number(entry.size) !== asset.size) {
        failures.push(`RELEASE_DRAFT_VERIFY_FAILED: ${asset.name} is ${String(entry.size)} bytes on the draft, expected ${asset.size}`);
        return await failBeforePublish();
      }
      let digest = typeof entry.digest === 'string' ? entry.digest.toLowerCase() : null;
      if (digest === null) {
        try {
          digest = `sha256:${sha256Hex(await downloadRemote(entry))}`;
        } catch (error) {
          failures.push(`RELEASE_DRAFT_VERIFY_FAILED: ${asset.name} cannot be re-read: ${String(error?.message ?? error)}`);
          return await failBeforePublish();
        }
      }
      if (digest !== `sha256:${asset.sha256}`) {
        failures.push(`RELEASE_DRAFT_VERIFY_FAILED: ${asset.name} digest is ${digest}, expected sha256:${asset.sha256}`);
        return await failBeforePublish();
      }
    }

    const sumsEntry = remote.find((candidate) => candidate?.name === SUMS_ASSET);
    if (sumsEntry === undefined) {
      failures.push(`RELEASE_DRAFT_VERIFY_FAILED: ${SUMS_ASSET} is missing from the draft`);
      return await failBeforePublish();
    }
    let remoteSums;
    try {
      remoteSums = await downloadRemote(sumsEntry);
    } catch (error) {
      failures.push(`RELEASE_DRAFT_VERIFY_FAILED: ${SUMS_ASSET} cannot be re-read: ${String(error?.message ?? error)}`);
      return await failBeforePublish();
    }
    if (!remoteSums.equals(local.get(SUMS_ASSET).data)) {
      failures.push(`RELEASE_DRAFT_VERIFY_FAILED: ${SUMS_ASSET} on the draft differs from the local asset`);
      return await failBeforePublish();
    }
    const sumsCheck = verifySums(remoteSums, [...local.values()].filter((asset) => asset.name !== SUMS_ASSET), {
      requireAll: true,
    });
    if (!sumsCheck.ok) {
      failures.push(...sumsCheck.failures.map((failure) => failure.replace(/^RELEASE_CHECKSUM_MISMATCH/, 'RELEASE_DRAFT_VERIFY_FAILED')));
      return await failBeforePublish();
    }

    // ---- PUBLISHING ------------------------------------------------------
    transitions.push('PUBLISHING');
    const patched = await call('PUBLISHING', 'PATCH', `/repos/${repo}/releases/${releaseId}`, {
      body: { draft: false, make_latest: 'false' },
    });
    if (!patched.ok) {
      failures.push(`RELEASE_PUBLISH_FAILED: PATCH draft=false on ${plan.tag} failed: HTTP ${patched.status}`);
      return await failBeforePublish();
    }
    published = true;
    transitions.push('PUBLISHED');

    const readBack = await call('PUBLISHED', 'GET', `/repos/${repo}/releases/${releaseId}`);
    if (!readBack.ok || readBack.data?.draft !== false) {
      failures.push(`RELEASE_PUBLISH_FAILED: ${plan.tag} was published but the read-back ${readBack.ok ? 'still reports a draft' : `failed (HTTP ${readBack.status})`}`);
      notes.push('The release is published: its assets stay untouched. Mark it prerelease if nobody installed it yet, or publish a new patch version; never rewrite the assets of this tag.');
      return finish({
        ok: false,
        state: 'PUBLISHED_UNVERIFIED',
        published: true,
        releaseId,
        recovery: 'mark-prerelease-or-new-patch',
      });
    }

    state = 'PUBLISHED';
    return finish({ ok: true, state: 'PUBLISHED', published: true, releaseId });
  } catch (error) {
    failures.push(errorLine(error));
    if (published) {
      notes.push('The release is published: its assets stay untouched. Mark it prerelease if nobody installed it yet, or publish a new patch version.');
      return finish({
        ok: false,
        state: 'PUBLISHED_UNVERIFIED',
        published: true,
        releaseId,
        recovery: 'mark-prerelease-or-new-patch',
      });
    }
    try {
      return await failBeforePublish();
    } catch (cleanupError) {
      notes.push(`rollback failed: ${String(cleanupError?.message ?? cleanupError)}`);
      return finish({ ok: false, state: 'FAILED', published: false, recovery: 'manual-cleanup' });
    }
  }
}
