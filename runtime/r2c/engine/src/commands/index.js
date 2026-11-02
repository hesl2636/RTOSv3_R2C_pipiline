/**
 * Command registry.
 *
 * Every command module exports `run(argv, ctx)`. The imports are static so the
 * architecture test sees the complete engine graph; an unknown name is a
 * usage error, never a silently missing module.
 */
import * as run from './run.js';
import * as next from './next.js';
import * as submit from './submit.js';
import * as status from './status.js';
import * as pause from './pause.js';
import * as resume from './resume.js';
import * as cancel from './cancel.js';
import * as tokenUsage from './token-usage.js';
import * as hook from './hook.js';
import * as validate from './validate.js';

const MODULES = Object.freeze({
  run,
  next,
  submit,
  status,
  pause,
  resume,
  cancel,
  'token-usage': tokenUsage,
  hook,
  validate,
});

export function commandNames() {
  return Object.keys(MODULES);
}

export async function loadCommand(name) {
  return MODULES[name] ?? null;
}
