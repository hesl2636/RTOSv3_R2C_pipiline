/**
 * Publish orchestration: credential gate, job state, Release lookup.
 *
 * The token lives in this closure only (decision #75 §8.1): it is never
 * serialised, logged, or placed in a URL or argv. Server-only module.
 */
import { BUILD_TTL_MS, installCommands } from './build.js';
import { runReleaseChild } from './child.js';
import { publishChildEnv, redactSecrets } from './env.js';
import { createRateLimiter, webError } from './http.js';

export const PUBLISH_TIMEOUT_MS = 300 * 1000;
export const PUBLISH_RATE_LIMIT = 10;
export const PUBLISH_RATE_WINDOW_MS = 60 * 60 * 1000;
export const PUBLISH_JOB_LOG_MAX = 200;
export const PUBLISH_LOG_LINE_MAX = 2000;
export const GH_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const BUNDLE_TAG_RE = /^bundle-[a-z0-9][a-z0-9-]*-v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
export const DEFAULT_GITHUB_API = 'https://api.github.com';

/** Parse `https://host/owner/repo(.git)` or `git@host:owner/repo(.git)`. */
function parseGitRemote(url) {
  const text = String(url).trim();
  const https = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(text);
  if (https !== null) return `${https[1]}/${https[2]}`;
  const ssh = /^(?:ssh:\/\/)?[^@/]+@[^:/]+[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(text);
  if (ssh !== null) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

/**
 * Target repository (decision #75 §8.2): `GH_REPO` wins, otherwise the
 * origin remote. The page can never choose a repository.
 */
function resolvePublishRepo(root, env, spawnSync) {
  const explicit = env.GH_REPO;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const value = explicit.trim();
    return GH_REPO_RE.test(value) ? value : null;
  }
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const repo = parseGitRemote(result.stdout);
  return repo !== null && GH_REPO_RE.test(repo) ? repo : null;
}

/** `HM2B_GITHUB_API` is operator-only (local fixture or mirror), never browser-settable. */
function resolveGithubApi(env) {
  const raw = env.HM2B_GITHUB_API;
  if (raw === undefined || raw.trim() === '') return DEFAULT_GITHUB_API;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return raw.trim().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function redactValue(value, secrets) {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value), secrets));
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{confirmTag, resume?, compiledWorkflowDigest?, resultDigests?}` (decision #75 §8.4/§8.5). */
export function parsePublishBody(body) {
  if (!isPlainObject(body)) return webError(400, 'WEB_BODY_INVALID', 'publish body must be a JSON object');
  for (const key of Object.keys(body)) {
    if (!['confirmTag', 'resume', 'compiledWorkflowDigest', 'resultDigests'].includes(key)) {
      return webError(400, 'WEB_BODY_INVALID', `unknown field ${key}`);
    }
  }
  if (typeof body.confirmTag !== 'string' || body.confirmTag === '') {
    return webError(400, 'WEB_BODY_INVALID', 'confirmTag is required');
  }
  if (body.resume !== undefined && typeof body.resume !== 'boolean') {
    return webError(400, 'WEB_BODY_INVALID', 'resume must be a boolean');
  }
  if (body.compiledWorkflowDigest !== undefined && (typeof body.compiledWorkflowDigest !== 'string' || !/^[0-9a-f]{64}$/.test(body.compiledWorkflowDigest))) {
    return webError(400, 'WEB_BODY_INVALID', 'compiledWorkflowDigest must be a sha256 digest');
  }
  if (body.resultDigests !== undefined && body.resultDigests !== null) {
    if (!isPlainObject(body.resultDigests)) {
      return webError(400, 'WEB_BODY_INVALID', 'resultDigests must be an object keyed by projection id');
    }
    for (const [key, value] of Object.entries(body.resultDigests)) {
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
        return webError(400, 'WEB_BODY_INVALID', `resultDigests.${key} must be a sha256 digest`);
      }
    }
  }
  return {
    confirmTag: body.confirmTag,
    resume: body.resume === true,
    compiledWorkflowDigest: body.compiledWorkflowDigest,
    resultDigests: body.resultDigests ?? null,
  };
}

function startupToken(env) {
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = env[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/**
 * Publish configuration plus job state. The credential gate is
 * `config.enabled` and is re-checked by the route on every request.
 *
 * @param {{
 *   root: string,
 *   secrets: string[],
 *   releaseScript: string,
 *   publishScript: string,
 *   publishTimeoutMs: number,
 *   env?: NodeJS.ProcessEnv,
 * }} options
 */
export function createPublishService({
  root,
  secrets,
  publishScript,
  publishTimeoutMs,
  env = process.env,
  node,
}) {
  const { randomBytes, spawnSync, mkdir, resolve, spawn } = node;
  // Release credentials stay in this closure: never serialized, never logged,
  // never placed in a URL or an argv (decision #75 §8).
  const token = startupToken(env);
  const repo = resolvePublishRepo(root, env, spawnSync);
  const apiBase = resolveGithubApi(env);
  const config = Object.freeze({
    repo,
    enabled: token !== null && repo !== null && apiBase !== null,
    reason: token === null ? 'no-token' : repo === null ? 'no-repo' : apiBase === null ? 'no-api' : null,
  });
  const jobs = new Map();
  const rate = createRateLimiter({ limit: PUBLISH_RATE_LIMIT, windowMs: PUBLISH_RATE_WINDOW_MS });
  let active = null;

  const recordPublishLog = (job, text) => {
    const line = redactSecrets(String(text), secrets).slice(0, PUBLISH_LOG_LINE_MAX);
    if (line === '') return;
    job.log.push(line);
    if (job.log.length > PUBLISH_JOB_LOG_MAX) job.log.splice(0, job.log.length - PUBLISH_JOB_LOG_MAX);
  };

  /** Release-form install commands for a published build (§13 frozen shape). */
  const publishedInstall = (build) => installCommands({
    id: build.summary.compiledWorkflow.id,
    version: build.summary.compiledWorkflow.version,
    projections: build.summary.projections,
    publishable: true,
  });

  const view = (job) => ({
    jobId: job.jobId,
    buildId: job.buildId,
    tag: job.tag,
    state: job.state,
    phase: job.phase,
    log: [...job.log],
    error: job.error,
    result: job.result,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  });

  const failJob = (job, code, message, details = null) => {
    job.state = 'FAILED';
    job.error = { code, message, details: redactValue(details, secrets) };
    job.finishedAt = Date.now();
    recordPublishLog(job, `${code}: ${message}`);
  };

  /**
   * The publish tool is the only child that keeps the credentials
   * (decision #75 §10.8). `--out` is the server's own build directory inside
   * the session temp root; the child gets a 300 s budget, its stdout is
   * JSON-lines, and a crash or timeout never touches the server.
   */
  const runPublishJob = async (build, tag, jobId = randomBytes(8).toString('hex')) => {
    const job = {
      jobId,
      buildId: build.summary.buildId,
      tag,
      state: 'RUNNING',
      phase: 'BUILD_READY',
      log: [],
      error: null,
      result: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    jobs.set(jobId, job);
    active = job;
    recordPublishLog(job, `BUILD_READY: ${tag}`);

    const outDir = resolve(build.dir, 'assets');
    const tmpDir = resolve(build.dir, 'publish-tmp');
    let child;
    try {
      await mkdir(tmpDir, { recursive: true, mode: 0o700 });
      const childEnv = publishChildEnv({
        ...env,
        TMPDIR: tmpDir,
        TEMP: tmpDir,
        TMP: tmpDir,
        GH_REPO: config.repo,
      });
      if (apiBase === DEFAULT_GITHUB_API) delete childEnv.HM2B_GITHUB_API;
      else childEnv.HM2B_GITHUB_API = apiBase;

      child = await runReleaseChild({
        spawn,
        script: publishScript,
        args: ['--publish', '--out', outDir, '--tag', tag, '--json'],
        env: childEnv,
        cwd: root,
        timeoutMs: publishTimeoutMs,
        secrets,
        onEvent: (event) => {
          if (event.event === 'phase' && typeof event.phase === 'string') {
            job.phase = event.phase;
            recordPublishLog(job, `phase ${event.phase}`);
          } else if (event.event === 'note' && typeof event.message === 'string') {
            recordPublishLog(job, `note: ${event.message}`);
          }
        },
      });
    } catch (error) {
      active = null;
      failJob(job, 'WEB_CHILD_FAILED', 'the publish child could not start', {
        stderr: String(error?.message ?? error),
      });
      return job;
    } finally {
      active = null;
    }

    for (const line of child.logLines.slice(0, 50)) recordPublishLog(job, line);
    const resultEvent = child.events.filter((event) => event.event === 'result').pop();
    const releaseView = resultEvent === undefined
      ? null
      : {
        state: resultEvent.state ?? null,
        published: resultEvent.published === true,
        releaseId: resultEvent.releaseId ?? null,
        recovery: resultEvent.recovery ?? null,
        failures: Array.isArray(resultEvent.failures) ? resultEvent.failures.slice(0, 20) : [],
        cleanup: resultEvent.cleanup ?? null,
      };

    if (child.status === 'timeout') {
      failJob(job, 'WEB_CHILD_TIMEOUT', 'the publish child was killed after the timeout', {
        timeoutMs: publishTimeoutMs,
        stderr: child.stderr,
        stderrTruncated: child.stderrTruncated,
      });
      return job;
    }
    if (child.status !== 'exited' || resultEvent === undefined || resultEvent.ok !== true) {
      failJob(job, 'WEB_CHILD_FAILED', 'the publish child failed', {
        exitCode: child.code,
        signal: child.signal,
        stderr: child.stderr,
        stderrTruncated: child.stderrTruncated,
        release: releaseView,
      });
      return job;
    }

    job.state = 'PUBLISHED';
    job.phase = 'PUBLISHED';
    job.result = {
      tag: typeof resultEvent.tag === 'string' ? resultEvent.tag : tag,
      state: 'PUBLISHED',
      releaseId: typeof resultEvent.releaseId === 'number' ? resultEvent.releaseId : null,
      published: true,
      assets: build.summary.artifacts.map((asset) => ({
        name: asset.name,
        bytes: asset.bytes,
        sha256: asset.sha256,
        url: asset.url,
      })),
      install: publishedInstall(build),
    };
    job.finishedAt = Date.now();
    recordPublishLog(job, `PUBLISHED: ${job.result.tag} (release ${String(job.result.releaseId)})`);
    return job;
  };

  /** `GET /api/releases/:tag` — read-only remote state for recovery. */
  const lookupRelease = async (tag) => {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'hm2b-web',
    };
    headers.Authorization = `Bearer ${token}`;
    const request = async (path) => {
      const response = await fetch(`${apiBase}/repos/${repo}${path}`, {
        headers,
        redirect: 'error',
      });
      return response;
    };
    const byTag = await request(`/releases/tags/${encodeURIComponent(tag)}`);
    if (byTag.status === 200) {
      const data = await byTag.json().catch(() => null);
      const assets = Array.isArray(data?.assets)
        ? data.assets.map((asset) => ({
          name: typeof asset?.name === 'string' ? asset.name : null,
          size: typeof asset?.size === 'number' ? asset.size : null,
          sha256: typeof asset?.digest === 'string' ? asset.digest.replace(/^sha256:/, '') : null,
        }))
        : [];
      return { state: data?.draft === true ? 'draft' : 'published', releaseId: data?.id ?? null, assets };
    }
    if (byTag.status !== 404) {
      return { error: byTag.status };
    }
    const ref = await request(`/git/ref/tags/${encodeURIComponent(tag)}`);
    if (ref.status === 200) return { state: 'tag-only', releaseId: null, assets: [] };
    if (ref.status === 404) return { state: 'absent', releaseId: null, assets: [] };
    return { error: ref.status };
  };

  const pruneState = (now = Date.now()) => {
    for (const [key, job] of jobs) {
      if (job.state !== 'RUNNING' && now - (job.finishedAt ?? job.startedAt) > BUILD_TTL_MS) {
        jobs.delete(key);
      }
    }
  };

  return {
    config,
    jobs,
    getJob: (jobId) => jobs.get(jobId),
    isBusy: () => active !== null,
    clearActive: () => { active = null; },
    takeRate: (now = Date.now()) => rate.take(now),
    runPublishJob,
    lookupRelease,
    view,
    failJob,
    pruneState,
  };
}
