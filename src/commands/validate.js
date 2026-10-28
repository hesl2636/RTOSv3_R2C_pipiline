/**
 * `r2c validate`: report every manifest problem in one pass.
 *
 * Exit 2 on any discovery, parse or validation error (spec §2/§3); 0 when the
 * manifest is valid. Warnings (missing `skill`) never change the exit code.
 */
import { flattenSteps, inspectManifest, manifestError } from '../manifest.js';

function counts(data) {
  if (data === null || typeof data !== 'object') return { stages: 0, steps: 0 };
  const stages = Array.isArray(data.stages) ? data.stages.length : 0;
  let steps = 0;
  try {
    steps = flattenSteps(data).length;
  } catch {
    steps = 0;
  }
  return { stages, steps };
}

export async function run(_argv, ctx) {
  const inspected = inspectManifest({ manifest: ctx.manifest, projectRoot: ctx.projectRoot });
  const { stages, steps } = counts(inspected.data);

  if (inspected.errors.length > 0) {
    if (!ctx.json) {
      for (const error of inspected.errors) {
        process.stderr.write(`error: ${error.path}: ${error.message} [${error.code}]\n`);
      }
      for (const warning of inspected.warnings) {
        process.stderr.write(`warning: ${warning.path}: ${warning.message}\n`);
      }
    }
    throw manifestError(inspected);
  }

  if (!ctx.json) {
    for (const warning of inspected.warnings) {
      process.stderr.write(`warning: ${warning.path}: ${warning.message}\n`);
    }
  }

  return {
    text: `manifest valid: ${inspected.manifestPath} (${stages} stages, ${steps} steps)\n`,
    data: {
      manifest: inspected.manifestPath,
      root: inspected.root,
      stages,
      steps,
      errors: [],
      warnings: inspected.warnings,
    },
  };
}
