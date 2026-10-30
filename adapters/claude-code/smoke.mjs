#!/usr/bin/env node
/**
 * Zero-model discovery probe for the claude-code adapter.
 *
 * Usage: node smoke.mjs <project-or-home-root> [--scope project|user]
 *
 * Delegates to `shims/smoke-discovery.mjs`: every mapped command, skill,
 * derived agent and link root must be visible after install. No agent binary
 * and no model call is involved.
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
