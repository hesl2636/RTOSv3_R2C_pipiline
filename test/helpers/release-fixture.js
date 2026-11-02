/**
 * Local HTTP fixtures for the release-source API (#107).
 *
 * Everything runs on 127.0.0.1 with an ephemeral port: pagination, tag
 * lookups, asset downloads, the draft → upload → verify → publish state
 * machine and failure injection. No test reaches the real GitHub API.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

export function jsonResponse(status, body, headers = {}) {
  return {
    status,
    headers: { 'content-type': JSON_TYPE, ...headers },
    body: Buffer.from(JSON.stringify(body), 'utf8'),
  };
}

export function rawResponse(status, body, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/octet-stream', ...headers },
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
  };
}

export function emptyResponse(status, headers = {}) {
  return { status, headers, body: Buffer.alloc(0) };
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Start a loopback HTTP server. `handler(ctx)` returns a response object, or
 * `undefined` for the default 404. Every request is recorded in `requests`.
 * `ctx` = `{method, path, url, query, headers, body}`.
 */
export async function startHttpFixture(t, handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const ctx = {
        method: request.method ?? 'GET',
        path: url.pathname,
        url: request.url ?? '/',
        query: url.searchParams,
        headers: request.headers,
        body,
      };
      requests.push(ctx);
      let reply;
      try {
        reply = await handler(ctx);
      } catch (error) {
        reply = jsonResponse(500, { message: `fixture error: ${error?.message ?? error}` });
      }
      if (reply === undefined || reply === null) {
        reply = jsonResponse(404, { message: 'Not Found' });
      }
      const headers = { 'content-length': String(reply.body.length), ...reply.headers };
      response.writeHead(reply.status, headers);
      response.end(reply.body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Stateful GitHub Releases fixture. It implements exactly the endpoints the
 * publish state machine and the token-based version lookup need, records every
 * call (method, URL, headers, body) and supports failure injection through
 * `fixture.intercept = (ctx) => response | undefined`.
 */
export async function startGithubFixture(t, options = {}) {
  const repo = options.repo ?? 'owner/repo';
  const withDigest = options.withDigest !== false;
  const requireToken = options.requireToken === true;
  const createTagOnDraft = options.createTagOnDraft === true;
  const releases = new Map();
  const assetsByRelease = new Map();
  const refs = new Map();
  const calls = [];
  let nextReleaseId = 1;
  let nextAssetId = 1;
  let origin = '';

  const api = `/repos/${repo}`;

  function assetSummary(asset) {
    const summary = {
      id: asset.id,
      name: asset.name,
      size: asset.data.length,
      url: `${origin}${api}/releases/assets/${asset.id}`,
      browser_download_url: `${origin}/download/${encodeURIComponent(asset.tag)}/${encodeURIComponent(asset.name)}`,
    };
    if (withDigest) summary.digest = `sha256:${sha256Hex(asset.data)}`;
    return summary;
  }

  function releaseJson(release) {
    return {
      id: release.id,
      tag_name: release.tag,
      name: release.name ?? release.tag,
      body: release.body ?? '',
      draft: release.draft,
      prerelease: release.prerelease,
      upload_url: `${origin}/uploads/${release.id}{?name,label}`,
      html_url: `${origin}/releases/${release.tag}`,
      assets: [...(assetsByRelease.get(release.id) ?? new Map()).values()].map(assetSummary),
    };
  }

  function addRelease({ tag, draft = false, prerelease = false, name = null, assets = [] }) {
    const id = nextReleaseId;
    nextReleaseId += 1;
    const release = { id, tag, name: name ?? tag, draft, prerelease, body: '' };
    releases.set(id, release);
    const assetMap = new Map();
    assetsByRelease.set(id, assetMap);
    for (const asset of assets) {
      const data = Buffer.isBuffer(asset.data) ? asset.data : Buffer.from(asset.data ?? '', 'utf8');
      assetMap.set(asset.name, { id: nextAssetId, name: asset.name, tag, data });
      nextAssetId += 1;
    }
    if (!draft) refs.set(tag, 'a'.repeat(40));
    return release;
  }

  for (const seeded of options.releases ?? []) addRelease(seeded);

  const fixture = {
    origin: null,
    apiBase: null,
    downloadBase: null,
    repo,
    calls,
    releases,
    refs,
    intercept: null,
    addRelease,
    addRef(tag, sha) {
      refs.set(tag, sha);
    },
    release(selector) {
      for (const release of releases.values()) {
        if (release.id === selector) return release;
        if (release.tag === selector) return release;
      }
      return null;
    },
    assets(releaseIdOrTag) {
      const release = fixture.release(releaseIdOrTag);
      if (release === null) return [];
      return [...(assetsByRelease.get(release.id) ?? new Map()).values()];
    },
    assetData(releaseIdOrTag, name) {
      const release = fixture.release(releaseIdOrTag);
      if (release === null) return null;
      const asset = (assetsByRelease.get(release.id) ?? new Map()).get(name);
      return asset === undefined ? null : asset.data;
    },
    callsOf(method, matcher) {
      const pattern = matcher === undefined ? null : new RegExp(matcher);
      return calls.filter((call) => call.method === method && (pattern === null || pattern.test(call.path)));
    },
  };

  function route(ctx) {
    if (requireToken && ctx.path.startsWith('/repos/') && !ctx.headers.authorization) {
      return jsonResponse(401, { message: 'Requires authentication' });
    }

    if (ctx.method === 'GET' && ctx.path === `${api}/releases`) {
      const perPage = Number(ctx.query.get('per_page') ?? '30');
      const page = Number(ctx.query.get('page') ?? '1');
      const ordered = [...releases.values()].sort((left, right) => right.id - left.id);
      const slice = ordered.slice((page - 1) * perPage, page * perPage);
      return jsonResponse(200, slice.map(releaseJson));
    }

    if (ctx.method === 'POST' && ctx.path === `${api}/releases`) {
      let body;
      try {
        body = JSON.parse(ctx.body.toString('utf8'));
      } catch {
        return jsonResponse(400, { message: 'Problems parsing JSON' });
      }
      const tag = body.tag_name;
      for (const release of releases.values()) {
        if (release.tag === tag) {
          return jsonResponse(422, { message: 'Validation Failed', errors: [{ code: 'already_exists', field: 'tag_name' }] });
        }
      }
      const release = addRelease({ tag, draft: body.draft === true, prerelease: body.prerelease === true, name: body.name });
      release.body = body.body ?? '';
      release.makeLatest = body.make_latest ?? null;
      release.targetCommitish = body.target_commitish ?? null;
      if (createTagOnDraft) refs.set(tag, release.targetCommitish ?? 'a'.repeat(40));
      return jsonResponse(201, releaseJson(release));
    }

    const tagMatch = new RegExp(`^${api}/releases/tags/([^/]+)$`).exec(ctx.path);
    if (tagMatch !== null && ctx.method === 'GET') {
      const tag = decodeURIComponent(tagMatch[1]);
      for (const release of releases.values()) if (release.tag === tag) return jsonResponse(200, releaseJson(release));
      return jsonResponse(404, { message: 'Not Found' });
    }

    const releaseMatch = new RegExp(`^${api}/releases/(\\d+)$`).exec(ctx.path);
    if (releaseMatch !== null && (ctx.method === 'GET' || ctx.method === 'PATCH')) {
      const release = releases.get(Number(releaseMatch[1]));
      if (release === undefined) return jsonResponse(404, { message: 'Not Found' });
      if (ctx.method === 'PATCH') {
        let body;
        try {
          body = JSON.parse(ctx.body.toString('utf8'));
        } catch {
          return jsonResponse(400, { message: 'Problems parsing JSON' });
        }
        if (Object.hasOwn(body, 'draft')) release.draft = body.draft === true;
        if (Object.hasOwn(body, 'make_latest')) release.makeLatest = body.make_latest;
        if (Object.hasOwn(body, 'prerelease')) release.prerelease = body.prerelease === true;
        if (!release.draft) refs.set(release.tag, release.targetCommitish ?? 'a'.repeat(40));
      }
      return jsonResponse(200, releaseJson(release));
    }

    const assetsMatch = new RegExp(`^${api}/releases/(\\d+)/assets$`).exec(ctx.path);
    if (assetsMatch !== null && ctx.method === 'GET') {
      const release = releases.get(Number(assetsMatch[1]));
      if (release === undefined) return jsonResponse(404, { message: 'Not Found' });
      return jsonResponse(200, releaseJson(release).assets);
    }

    const uploadMatch = new RegExp(`^/uploads/(\\d+)$`).exec(ctx.path);
    if (uploadMatch !== null && ctx.method === 'POST') {
      const release = releases.get(Number(uploadMatch[1]));
      if (release === undefined) return jsonResponse(404, { message: 'Not Found' });
      if (!release.draft) return jsonResponse(422, { message: 'Forbidden: assets of a published release are immutable' });
      const name = ctx.query.get('name');
      if (typeof name !== 'string' || name === '') return jsonResponse(400, { message: 'name is required' });
      const assetMap = assetsByRelease.get(release.id);
      if (assetMap.has(name)) {
        return jsonResponse(422, { message: 'Validation Failed', errors: [{ code: 'already_exists', field: 'name' }] });
      }
      const asset = { id: nextAssetId, name, tag: release.tag, data: Buffer.from(ctx.body) };
      nextAssetId += 1;
      assetMap.set(name, asset);
      return jsonResponse(201, assetSummary(asset));
    }

    const assetMatch = new RegExp(`^${api}/releases/assets/(\\d+)$`).exec(ctx.path);
    if (assetMatch !== null && ctx.method === 'GET') {
      const id = Number(assetMatch[1]);
      for (const assetMap of assetsByRelease.values()) {
        for (const asset of assetMap.values()) {
          if (asset.id === id) return rawResponse(200, asset.data);
        }
      }
      return jsonResponse(404, { message: 'Not Found' });
    }

    const downloadMatch = /^\/download\/([^/]+)\/([^/]+)$/.exec(ctx.path);
    if (downloadMatch !== null && ctx.method === 'GET') {
      const tag = decodeURIComponent(downloadMatch[1]);
      const name = decodeURIComponent(downloadMatch[2]);
      for (const release of releases.values()) {
        if (release.tag !== tag) continue;
        const asset = (assetsByRelease.get(release.id) ?? new Map()).get(name);
        if (asset !== undefined) return rawResponse(200, asset.data);
      }
      return jsonResponse(404, { message: 'Not Found' });
    }

    const refMatch = new RegExp(`^${api}/git/refs?/tags/([^/]+)$`).exec(ctx.path);
    if (refMatch !== null && (ctx.method === 'GET' || ctx.method === 'DELETE')) {
      const tag = decodeURIComponent(refMatch[1]);
      if (!refs.has(tag)) {
        return ctx.method === 'DELETE'
          ? jsonResponse(422, { message: 'Reference does not exist' })
          : jsonResponse(404, { message: 'Not Found' });
      }
      if (ctx.method === 'DELETE') {
        refs.delete(tag);
        return emptyResponse(204);
      }
      return jsonResponse(200, {
        ref: `refs/tags/${tag}`,
        object: { type: 'commit', sha: refs.get(tag) },
      });
    }

    const deleteMatch = new RegExp(`^${api}/releases/(\\d+)$`).exec(ctx.path);
    if (deleteMatch !== null && ctx.method === 'DELETE') {
      const id = Number(deleteMatch[1]);
      if (!releases.has(id)) return jsonResponse(404, { message: 'Not Found' });
      releases.delete(id);
      assetsByRelease.delete(id);
      return emptyResponse(204);
    }

    return undefined;
  }

  const server = await startHttpFixture(t, (ctx) => {
    calls.push({ method: ctx.method, path: ctx.path, url: ctx.url, headers: ctx.headers, body: ctx.body });
    if (typeof fixture.intercept === "function") {
      const injected = fixture.intercept(ctx);
      if (injected !== undefined && injected !== null) return injected;
    }
    return route(ctx);
  });

  origin = server.origin;
  fixture.origin = server.origin;
  fixture.apiBase = server.origin;
  fixture.downloadBase = `${server.origin}/download`;
  fixture.server = server;
  return fixture;
}
