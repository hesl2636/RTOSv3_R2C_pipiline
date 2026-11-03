/**
 * Role / skill / constitution checks (decision #67 §7.5–§7.8).
 *
 * Placeholders are first-class: a placeholder role may have an empty body, a
 * placeholder skill must still carry the visible banner, and a declared
 * placeholder constitution may be a 0-byte file (with a warning).
 */
import { codePointLength, compareCodePoints } from '../../core/code-point.js';
import { parseFrontmatter } from '../frontmatter.js';
import { ROLE_ENUMS, TOOL_TOKENS } from '../ids.js';
import { nonEmptyLines, preamble } from '../util.js';

const ROLE_KEYS = ['id', 'description', 'title', 'mode', 'model', 'effort', 'tools', 'tools_deny', 'skills', 'placeholder'];
const SKILL_KEYS = ['name', 'description', 'placeholder'];
const PLACEHOLDER_BANNER = /^> \*\*占位（placeholder）\*\*/m;
const ROLE_LEAK = /\{\{submit\}\}|\.(?:hm2b|r2c)\/engine\b/;

function frontmatterInvalid(context, path, line, reason, message, pointer = null) {
  context.fail(path, 'BUNDLE_FRONTMATTER_INVALID', message, {
    line,
    pointer,
    details: pointer === null ? { reason } : { reason, pointer },
  });
}

/**
 * Structural set rules that JSON Schema cannot express (decision #67 §7.2):
 * arrays here are sets written in ascending code-point order. One diagnostic
 * per array — a duplicate and a misordering share the same root cause.
 */
function checkSortedArray(context, path, key, values) {
  if (!Array.isArray(values)) return;
  let duplicate = null;
  let outOfOrder = false;
  for (let index = 1; index < values.length; index += 1) {
    const order = compareCodePoints(values[index - 1], values[index]);
    if (order > 0) outOfOrder = true;
    else if (order === 0 && duplicate === null) duplicate = index;
  }
  if (outOfOrder) {
    const pointer = `/${key}`;
    context.fail(path, 'BUNDLE_SCHEMA_INVALID', `'${key}' must be sorted ascending`, {
      pointer,
      details: { pointer, rule: 'sorted' },
    });
  } else if (duplicate !== null) {
    const pointer = `/${key}/${duplicate}`;
    context.fail(path, 'BUNDLE_SCHEMA_INVALID', `'${key}' must not repeat entries`, {
      pointer,
      details: { pointer, rule: 'uniqueItems' },
    });
  }
}

function checkUnknownFrontmatterKeys(context, path, fields, allowed) {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) {
      context.fail(path, 'BUNDLE_FRONTMATTER_UNKNOWN_KEY', `unknown frontmatter key: ${key}`, {
        pointer: `/${key}`,
        details: { key },
      });
    }
  }
}

function checkRole(context, id, record) {
  const { path, text, bytes } = record;
  const parsed = parseFrontmatter(text, { path });
  context.diagnostics.push(...parsed.diagnostics);
  // S6: a frontmatter parse failure owns every frontmatter-derived check.
  const fieldsOk = parsed.fields !== null && parsed.diagnostics.length === 0;
  if (parsed.fields === null) {
    if (parsed.diagnostics.length === 0) {
      context.fail(path, 'BUNDLE_FRONTMATTER_MISSING', 'roles require frontmatter');
    }
  } else if (fieldsOk) {
    const fields = parsed.fields;
    checkUnknownFrontmatterKeys(context, path, fields, ROLE_KEYS);
    for (const key of ['id', 'description']) {
      if (fields[key] === undefined) frontmatterInvalid(context, path, 1, 'required', `role frontmatter is missing '${key}'`, `/${key}`);
    }
    if (fields.id !== undefined) {
      if (typeof fields.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.id) || fields.id.length > 64) {
        context.fail(path, 'BUNDLE_ROLE_ID_INVALID', 'role id is invalid', { details: { value: fields.id } });
      } else if (fields.id !== id) {
        context.fail(path, 'BUNDLE_ROLE_ID_MISMATCH', 'role id does not match the file name', {
          details: { declared: id, stem: id, actual: fields.id },
        });
      }
      // The manifest declaration already owns the reserved-id diagnostic for
      // declared roles; only report it here when the file disagrees.
      if ((fields.id === 'main' || fields.id === 'sub')
        && !context.declared.roles.includes(fields.id)) {
        context.fail(path, 'BUNDLE_ROLE_ID_RESERVED', 'role id is reserved', { details: { value: fields.id } });
      }
    }
    if (fields.description !== undefined) {
      if (typeof fields.description !== 'string' || codePointLength(fields.description) < 1
        || codePointLength(fields.description) > 1024) {
        context.fail(path, 'BUNDLE_ROLE_DESCRIPTION_LENGTH', 'role description must be 1-1024 characters');
      } else if (codePointLength(fields.description) > 200) {
        context.warn(path, 'BUNDLE_ROLE_DESCRIPTION_LONG', 'role description is longer than 200 characters');
      }
    }
    if (fields.title !== undefined) {
      if (typeof fields.title !== 'string' || codePointLength(fields.title) < 1 || codePointLength(fields.title) > 120) {
        context.fail(path, 'BUNDLE_SCHEMA_INVALID', 'role title must be 1-120 characters', {
          pointer: '/title',
          details: { pointer: '/title', rule: 'length' },
        });
      }
    }
    for (const key of ['mode', 'model', 'effort']) {
      if (fields[key] !== undefined && !ROLE_ENUMS[key].includes(fields[key])) {
        context.fail(path, 'BUNDLE_ROLE_ENUM_INVALID', `role ${key} is not a supported value`, {
          pointer: `/${key}`,
          details: { key, value: fields[key] },
        });
      }
    }
    for (const key of ['tools', 'tools_deny']) {
      if (fields[key] === undefined) continue;
      if (!Array.isArray(fields[key])) {
        frontmatterInvalid(context, path, 1, 'shape', `'${key}' must be a list`, `/${key}`);
        continue;
      }
      fields[key].forEach((token, index) => {
        if (!TOOL_TOKENS.includes(token)) {
          const pointer = `/${key}/${index}`;
          context.fail(path, 'BUNDLE_ROLE_TOOL_UNKNOWN', `unknown role tool token: ${token}`, {
            pointer,
            details: { token, pointer },
          });
        }
      });
      checkSortedArray(context, path, key, fields[key]);
    }
    if (fields.skills !== undefined) {
      if (!Array.isArray(fields.skills)) {
        frontmatterInvalid(context, path, 1, 'shape', "'skills' must be a list", '/skills');
      } else {
        checkSortedArray(context, path, 'skills', fields.skills);
        if (context.declaredValid.skills !== false) {
          for (const skill of fields.skills) {
            if (!context.declared.skills.includes(skill)) {
              context.fail(path, 'BUNDLE_ROLE_SKILL_UNDECLARED', `role preloads an undeclared skill: ${skill}`, {
                details: { id: skill },
              });
            }
          }
        }
      }
    }
    if (fields.placeholder !== undefined && typeof fields.placeholder !== 'boolean') {
      frontmatterInvalid(context, path, 1, 'boolean', "'placeholder' must be true or false", '/placeholder');
    }
    if (fields.placeholder !== true && nonEmptyLines(parsed.body).length === 0) {
      context.fail(path, 'BUNDLE_ROLE_BODY_EMPTY', 'role instructions are empty');
    }
    record.fields = fields;
  }
  if (ROLE_LEAK.test(parsed.body)) {
    const line = parsed.body.split('\n').findIndex((textLine) => ROLE_LEAK.test(textLine)) + parsed.bodyLine;
    context.warn(path, 'BUNDLE_ROLE_RUNTIME_LEAK', 'role instructions mention the runner', { line });
  }
  record.body = parsed.body;
  record.bytes = bytes;
  return record;
}

function checkSkills(context) {
  const collapsed = context.declaredValid.skills !== false;
  const declared = context.declared.skills;
  const directories = new Map();
  for (const entry of context.entries.values()) {
    const match = /^skills\/([^/]+)\/([^/]+)$/.exec(entry.path);
    if (match === null) continue;
    const [, id, file] = match;
    if (!directories.has(id)) directories.set(id, []);
    directories.get(id).push({ file, path: entry.path });
  }

  if (collapsed) {
    for (const [id, files] of directories) {
      if (declared.includes(id)) continue;
      const first = files[0];
      context.fail(first.path, 'BUNDLE_SKILL_DIR_UNDECLARED', `skill directory is not declared: ${id}`, {
        details: { id },
      });
    }
  }

  const records = new Map();
  for (const id of declared) {
    const path = `skills/${id}/SKILL.md`;
    if (!context.entries.has(path)) {
      if (!context.rejectedPaths.has(path)) {
        context.fail(path, 'BUNDLE_SKILL_FILE_MISSING', `declared skill '${id}' has no SKILL.md`, {
          details: { id },
        });
      }
      continue;
    }
    const entry = context.entries.get(path);
    if (entry.size === 0) {
      context.fail(path, 'BUNDLE_SKILL_EMPTY_FILE', 'skill file is empty');
      continue;
    }
    const text = context.texts.get(path);
    if (text === undefined) continue;
    const parsed = parseFrontmatter(text, { path });
    context.diagnostics.push(...parsed.diagnostics);
    const record = { id, path, bytes: entry.data, text, fields: parsed.fields, body: parsed.body };
    // S6: a frontmatter parse failure owns every frontmatter-derived check,
    // including the placeholder state that gates the banner and body checks.
    const fieldsOk = parsed.fields !== null && parsed.diagnostics.length === 0;
    if (parsed.fields === null) {
      if (parsed.diagnostics.length === 0) {
        context.fail(path, 'BUNDLE_FRONTMATTER_MISSING', 'skills require frontmatter');
      }
    } else if (fieldsOk) {
      const fields = parsed.fields;
      checkUnknownFrontmatterKeys(context, path, fields, SKILL_KEYS);
      for (const key of ['name', 'description']) {
        if (fields[key] === undefined) {
          frontmatterInvalid(context, path, 1, 'required', `skill frontmatter is missing '${key}'`, `/${key}`);
        }
      }
      if (fields.name !== undefined) {
        if (typeof fields.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name)
          || fields.name.length > 64) {
          context.fail(path, 'BUNDLE_SKILL_ID_INVALID', 'skill name is invalid', { details: { value: fields.name } });
        } else if (fields.name !== id) {
          context.fail(path, 'BUNDLE_SKILL_ID_MISMATCH', 'skill name does not match the directory', {
            details: { declared: id, stem: id, actual: fields.name },
          });
        }
        // The manifest declaration already owns the reserved-id diagnostic for
        // declared skills; only report it here when the file disagrees.
        if ((fields.name === 'synced' || fields.name === 'anthropic-skills')
          && !context.declared.skills.includes(fields.name)) {
          context.fail(path, 'BUNDLE_SKILL_ID_RESERVED', 'skill id is reserved', { details: { value: fields.name } });
        }
      }
      if (fields.description !== undefined) {
        if (typeof fields.description !== 'string' || codePointLength(fields.description) < 1
          || codePointLength(fields.description) > 1024) {
          context.fail(path, 'BUNDLE_SCHEMA_INVALID', 'skill description must be 1-1024 characters', {
            pointer: '/description',
            details: { pointer: '/description', rule: 'length' },
          });
        }
      }
      if (fields.placeholder !== undefined && typeof fields.placeholder !== 'boolean') {
        frontmatterInvalid(context, path, 1, 'boolean', "'placeholder' must be true or false", '/placeholder');
      }
      if (fields.placeholder === true && !PLACEHOLDER_BANNER.test(preamble(parsed.body))) {
        context.fail(path, 'BUNDLE_SKILL_PLACEHOLDER_BANNER', 'placeholder skill is missing the visible banner');
      }
    }
    if (fieldsOk && parsed.fields.placeholder !== true && nonEmptyLines(parsed.body).length === 0) {
      context.fail(path, 'BUNDLE_SKILL_BODY_EMPTY', 'skill body is empty');
    }
    records.set(id, record);
  }
  context.skills = records;
}

function checkConstitution(context) {
  const declaration = context.constitutionDeclaration;
  if (declaration === undefined || declaration.valid === false) return;
  const path = 'constitution/CONSTITUTION.md';
  const present = context.entries.has(path);
  // The whitelist only admits `constitution/` when the manifest declares it;
  // a bare directory entry is the same mistake as an undeclared file.
  const directoryPresent = context.directories.some((directory) => directory.path === 'constitution');
  if (declaration.declared && !present) {
    if (!context.rejectedPaths.has(path)) {
      context.fail(path, 'BUNDLE_CONSTITUTION_MISSING', 'bundle declares a constitution but the file is missing');
    }
    return;
  }
  if (!declaration.declared) {
    if (present || directoryPresent) {
      context.fail(path, 'BUNDLE_CONSTITUTION_UNDECLARED', 'constitution file is not declared in bundle.json');
    }
    return;
  }
  if (!present) return;

  const entry = context.entries.get(path);
  const text = context.texts.get(path);
  if (entry.size > context.limits.MAX_CONSTITUTION_BYTES) {
    context.fail(path, 'BUNDLE_CONSTITUTION_TOO_LARGE', 'constitution exceeds the size limit', {
      details: { limit: context.limits.MAX_CONSTITUTION_BYTES, actual: entry.size },
    });
  }
  if (text === undefined) return;
  if (/^---(\n|$)/.test(text)) {
    context.fail(path, 'BUNDLE_CONSTITUTION_FRONTMATTER', 'constitution must not carry frontmatter');
  }
  if (!declaration.placeholder && nonEmptyLines(text).length === 0) {
    context.fail(path, 'BUNDLE_CONSTITUTION_EMPTY', 'constitution is empty');
  }
  if (declaration.placeholder) {
    context.warn(path, 'BUNDLE_CONSTITUTION_PLACEHOLDER', 'constitution is a placeholder');
  }
  context.constitution = {
    path,
    bytes: entry.data,
    text,
    placeholder: declaration.placeholder,
  };
}

function checkRoles(context) {
  if (context.declaredValid.roles === false) return;
  const declared = context.declared.roles;
  const records = new Map();
  for (const entry of context.entries.values()) {
    const match = /^roles\/([^/]+)\.md$/.exec(entry.path);
    if (match === null) continue;
    if (!declared.includes(match[1])) {
      context.fail(entry.path, 'BUNDLE_ROLE_FILE_UNDECLARED', 'role file is not declared in bundle.json.roles', {
        details: { id: match[1] },
      });
    }
  }
  for (const id of declared) {
    const path = `roles/${id}.md`;
    if (!context.entries.has(path)) {
      if (!context.rejectedPaths.has(path)) {
        context.fail(path, 'BUNDLE_ROLE_FILE_MISSING', `declared role '${id}' has no file`, { details: { id } });
      }
      continue;
    }
    const entry = context.entries.get(path);
    const text = context.texts.get(path);
    if (text === undefined) continue;
    records.set(id, checkRole(context, id, { id, path, bytes: entry.data, text }));
  }
  context.roles = records;
}

export function check(context) {
  if (context.skipped.entities) return;
  checkRoles(context);
  if (context.declaredValid.skills !== false) checkSkills(context);
  checkConstitution(context);
}
