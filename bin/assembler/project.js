/** `r2c-assembler project <ir> --projection <id> [options] [--json]`. */
import { chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { toEnvelope } from '../../core/diagnostics.js';
import { isInside } from '../../core/paths.js';
import { atomicWriteFile } from '../../core/node/atomic-write.js';
import { sha256Hex } from '../../core/node/sha256.js';
import { IR_SUMMARY_CODE, validateIr } from '../../assembler/validate-ir.js';
import { normalizeOptions } from '../../projection/options.js';
import { project } from '../../projection/project.js';
import { getProjection } from '../../projection/registry.js';
import { validateResult } from '../../projection/validate-result.js';
import {
  EXIT_CODES,
  emitFailure,
  emitReport,
  formatDiagnostic,
  jsonRequested,
  parseArgs,
  readInput,
  usageError,
  writeEnvelope,
} from './common.js';

const COMMAND = 'project';
const USAGE = 'usage: project <workflow.ir.json> --projection <id> [--target <id> ...] [--stage-order a,b] [--skills a,b] [--out <dir>] [--json]';

function list(value) {
  return value === undefined ? null : value.split(',');
}

function summary(result) {
  const bytes = result.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
  return {
    projection: result.projection,
    ir: result.ir,
    targets: result.targets,
    options: result.options,
    coverage: result.coverage,
    counts: {
      files: result.files.length,
      bytes,
      degradations: result.degradations.length,
      warnings: result.warnings.length,
      capabilities: result.capabilityReport.length,
    },
    files: result.files.map((file) => ({
      path: file.path,
      targets: file.targets,
      kind: file.kind,
      mode: file.mode,
      sha256: sha256Hex(file.content),
    })),
    capabilityReport: result.capabilityReport,
    degradations: result.degradations,
    warnings: result.warnings,
    metadata: result.metadata,
  };
}

export function run(argv) {
  const parsed = parseArgs(argv, {
    values: ['projection', 'stage-order', 'skills'],
    lists: ['target'],
  });
  if (parsed.error !== undefined) {
    return emitFailure({ json: jsonRequested(argv), command: COMMAND, code: EXIT_CODES.USAGE, error: parsed.error });
  }
  const { options } = parsed;
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_CODES.OK;
  }
  const projectionId = options.values.projection;
  if (options.positionals.length !== 1 || projectionId === undefined) {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: usageError(USAGE),
    });
  }
  const descriptor = getProjection(projectionId);
  if (descriptor === null) {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: { code: 'PROJECTION_NOT_REGISTERED', message: `projection ${projectionId} is not registered`, details: null },
    });
  }

  const input = readInput(options.positionals[0], {
    notFound: 'IR_INPUT_NOT_FOUND',
    unreadable: 'IR_INPUT_UNREADABLE',
  });
  if (!input.ok) {
    return emitFailure({ json: options.json, command: COMMAND, code: EXIT_CODES.USAGE, error: input.error });
  }
  const report = validateIr(input.bytes, { sha256: sha256Hex });
  if (!report.ok) {
    return emitReport({
      json: options.json,
      command: COMMAND,
      report,
      summaryCode: IR_SUMMARY_CODE,
    });
  }

  const ir = JSON.parse(new TextDecoder().decode(input.bytes));
  const irDigest = sha256Hex(input.bytes);
  const normalized = normalizeOptions({
    projectionId,
    ir,
    irDigest,
    raw: {
      stageOrder: list(options.values['stage-order']),
      skills: list(options.values.skills),
      targets: options.lists.target ?? null,
    },
    manifest: descriptor,
  });
  if (!normalized.ok) {
    const first = normalized.errors[0];
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: { code: first.code, message: first.message, details: { errors: normalized.errors } },
      data: options.json ? { options: normalized.options, errors: normalized.errors } : null,
    });
  }

  const result = project({
    projectionId,
    ir,
    irDigest,
    options: normalized.options,
    environment: {},
    assets: {},
  });
  if (!result.ok) {
    const first = result.errors[0];
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: { code: first.code, message: first.message, details: { errors: result.errors } },
      data: options.json ? result : null,
    });
  }

  const validation = validateResult(result, {
    ir,
    irDigest,
    options: normalized.options,
    manifest: descriptor,
    environment: {},
    assets: {},
  });
  if (!validation.ok) {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: {
        code: 'PROJECTION_RESULT_INVALID',
        message: validation.diagnostics[0].message,
        details: { diagnostics: validation.diagnostics },
      },
    });
  }

  const data = summary(result);
  if (options.out !== null) {
    const root = resolve(options.out);
    for (const file of result.files) {
      const target = join(root, ...file.path.split('/'));
      if (!isInside(root, target)) {
        return emitFailure({
          json: options.json,
          command: COMMAND,
          code: EXIT_CODES.USAGE,
          error: { code: 'PROJECTION_PATH_INVALID', message: `${file.path} escapes the output directory`, details: { path: file.path } },
        });
      }
      try {
        atomicWriteFile(target, file.content);
        if (file.mode === 0o755) chmodSync(target, 0o755);
      } catch {
        return emitFailure({
          json: options.json,
          command: COMMAND,
          code: EXIT_CODES.USAGE,
          error: { code: 'OUTPUT_UNWRITABLE', message: `could not write ${file.path}`, details: { path: file.path } },
        });
      }
    }
    data.output = { files: result.files.length };
  } else {
    data.output = null;
  }

  if (options.json) {
    writeEnvelope(toEnvelope({ command: COMMAND, code: EXIT_CODES.OK, data }));
    return EXIT_CODES.OK;
  }
  for (const warning of result.warnings) {
    process.stderr.write(`${formatDiagnostic({ severity: 'warning', code: warning.code, path: '', line: null, pointer: warning.pointer ?? null, message: warning.message })}\n`);
  }
  process.stdout.write(`${result.projection.id}[${result.targets.join(',')}]: ${data.counts.files} files (${data.counts.bytes} bytes), ${data.counts.degradations} degradations, ${data.counts.capabilities} capability rows\n`);
  if (result.metadata.artifacts['roles-json'] !== undefined) {
    process.stdout.write(`roles.json: ${result.metadata.artifacts['roles-json']}\n`);
  }
  return EXIT_CODES.OK;
}
