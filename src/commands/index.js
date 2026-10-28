/**
 * Command registry.
 *
 * Every command module exports `run(argv, ctx)`. Loading is lazy and tolerant
 * of files that later tickets add (status/pause/...): a missing module is
 * reported as an unknown command instead of breaking the whole surface.
 */
export const COMMANDS = Object.freeze({
  run: './run.js',
  next: './next.js',
  submit: './submit.js',
  status: './status.js',
  pause: './pause.js',
  resume: './resume.js',
  cancel: './cancel.js',
  'token-usage': './token-usage.js',
  hook: './hook.js',
  validate: './validate.js',
  adapter: './adapter.js',
  acceptance: './acceptance.js',
});

export function commandNames() {
  return Object.keys(COMMANDS);
}

export async function loadCommand(name) {
  const file = COMMANDS[name];
  if (!file) return null;
  try {
    return await import(new URL(file, import.meta.url));
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(file.slice(2))) {
      return null;
    }
    throw error;
  }
}
