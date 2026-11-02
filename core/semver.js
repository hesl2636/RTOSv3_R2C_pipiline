/**
 * Restricted semver evaluator (pure port of `src/version.js` semantics).
 *
 *   version  MAJOR.MINOR.PATCH[-PRERELEASE]   (build metadata is ignored)
 *   range    comparator (SP comparator)* ('||' comparator-conjunction)*
 *   operator ^ ~ >= > <= < = or bare (equality)
 *
 * Prerelease identifiers follow semver §11 precedence. Anything outside the
 * grammar is rejected instead of being coerced.
 */
export class SemverError extends Error {
  constructor(message, value) {
    super(message);
    this.name = 'SemverError';
    this.code = 'EINVALID_SEMVER';
    this.value = value;
  }
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PRERELEASE_RE = /^[0-9A-Za-z-]+$/;
const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~)?\s*(\S+)$/;

function numeric(value, label, raw) {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new SemverError(`invalid ${label} component in version: ${raw}`, raw);
  }
  return Number.parseInt(value, 10);
}

/** Parse a version; returns `{ major, minor, patch, prerelease: [] }`. */
export function parseSemver(raw) {
  if (typeof raw !== 'string') throw new SemverError(`version must be a string: ${raw}`, raw);
  const match = VERSION_RE.exec(raw.trim());
  if (match === null) throw new SemverError(`invalid version: ${raw}`, raw);
  const [, majorText, minorText, patchText, prereleaseText] = match;
  const prerelease = prereleaseText === undefined ? [] : prereleaseText.split('.');
  for (const identifier of prerelease) {
    if (!PRERELEASE_RE.test(identifier)) {
      throw new SemverError(`invalid prerelease identifier "${identifier}" in ${raw}`, raw);
    }
    if (/^\d+$/.test(identifier) && !/^(0|[1-9]\d*)$/.test(identifier)) {
      throw new SemverError(`numeric prerelease identifiers must not have leading zeros: ${raw}`, raw);
    }
  }
  return {
    major: numeric(majorText, 'major', raw),
    minor: numeric(minorText, 'minor', raw),
    patch: numeric(patchText, 'patch', raw),
    prerelease,
  };
}

export function isValidVersion(raw) {
  try {
    parseSemver(raw);
    return true;
  } catch {
    return false;
  }
}

function compareParsed(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  const leftPre = left.prerelease;
  const rightPre = right.prerelease;
  if (leftPre.length === 0 && rightPre.length === 0) return 0;
  if (leftPre.length === 0) return 1;
  if (rightPre.length === 0) return -1;
  const length = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftPre[index];
    const b = rightPre[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** Semver §11 precedence over two version strings; throws on invalid input. */
export function compareSemver(left, right) {
  return compareParsed(parseSemver(left), parseSemver(right));
}

function tuple(major, minor, patch, prerelease = []) {
  return { major, minor, patch, prerelease };
}

function caretBounds(target) {
  const { major, minor, patch } = target;
  if (major > 0) return [tuple(major, minor, patch, target.prerelease), tuple(major + 1, 0, 0)];
  if (minor > 0) return [tuple(0, minor, patch, target.prerelease), tuple(0, minor + 1, 0)];
  return [tuple(0, 0, patch, target.prerelease), tuple(0, 0, patch + 1)];
}

function tildeBounds(target) {
  const { major, minor, patch } = target;
  return [tuple(major, minor, patch, target.prerelease), tuple(major, minor + 1, 0)];
}

const PARTIAL_VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseRangeTarget(raw) {
  if (typeof raw !== 'string') throw new SemverError(`invalid version: ${raw}`, raw);
  const match = PARTIAL_VERSION_RE.exec(raw.trim());
  if (match === null) throw new SemverError(`invalid version: ${raw}`, raw);
  const [, majorText, minorText = '0', patchText = '0', prereleaseText] = match;
  return parseSemver(
    `${majorText}.${minorText}.${patchText}${prereleaseText === undefined ? '' : `-${prereleaseText}`}`,
  );
}

function comparatorPredicate(operator, rawTarget) {
  const target = parseRangeTarget(rawTarget);
  switch (operator) {
    case '^': {
      const [lower, upper] = caretBounds(target);
      return (version) => compareParsed(version, lower) >= 0 && compareParsed(version, upper) < 0;
    }
    case '~': {
      const [lower, upper] = tildeBounds(target);
      return (version) => compareParsed(version, lower) >= 0 && compareParsed(version, upper) < 0;
    }
    case '>=':
      return (version) => compareParsed(version, target) >= 0;
    case '>':
      return (version) => compareParsed(version, target) > 0;
    case '<=':
      return (version) => compareParsed(version, target) <= 0;
    case '<':
      return (version) => compareParsed(version, target) < 0;
    case '=':
    case undefined:
      return (version) => compareParsed(version, target) === 0;
    default:
      throw new SemverError(`unsupported comparator: ${operator}`, operator);
  }
}

/** Parse a range into an array of comparator-conjunction predicates. */
export function parseRange(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SemverError(`invalid range: ${raw}`, raw);
  }
  return raw
    .trim()
    .split('||')
    .map((group) => {
      const text = group.trim();
      if (text === '') throw new SemverError(`empty range alternative: ${raw}`, raw);
      return text.split(/\s+/).map((term) => {
        const match = COMPARATOR_RE.exec(term);
        if (match === null) throw new SemverError(`invalid comparator "${term}" in range ${raw}`, raw);
        return comparatorPredicate(match[1], match[2]);
      });
    });
}

export function isValidRange(raw) {
  try {
    parseRange(raw);
    return true;
  } catch {
    return false;
  }
}

/** True when `version` satisfies `range`; invalid inputs throw SemverError. */
export function satisfiesRange(range, version) {
  const parsed = parseSemver(version);
  return parseRange(range).some((comparators) => comparators.every((test) => test(parsed)));
}
