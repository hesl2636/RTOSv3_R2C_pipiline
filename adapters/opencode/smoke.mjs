#!/usr/bin/env node
/**
 * Zero-model discovery probe for the opencode adapter.
 *
 * Usage: node smoke.mjs <project-or-home-root> [--scope project|user]
 *
 * Delegates to `shims/smoke-discovery.mjs`. `opencode run --command r2c-status`
 * is a live check and is intentionally not run here.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDiscovery } from '../../shims/smoke-discovery.mjs';

const adapterDir = dirname(fileURLToPath(import.meta.url));
const payloadArg = process.argv.indexOf('--payload');
const payloadRoot =
  payloadArg === -1 ? resolve(adapterDir, '..', '..') : resolve(process.argv[payloadArg + 1]);
const scopeIndex = process.argv.indexOf('--scope');
const scope = scopeIndex === -1 ? 'project' : process.argv[scopeIndex + 1];

process.exit(runDiscovery({ adapterDir, payloadRoot, root: process.argv[2], scope }));
