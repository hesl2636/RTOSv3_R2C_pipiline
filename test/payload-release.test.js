import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseEndpoints } from '../src/adapter/release.js';
import { payloadAssetName } from '../src/plugin.js';

test('a token routes the payload download through the GitHub API', () => {
  const endpoints = releaseEndpoints({ version: '0.1.0', token: 'x' });
  assert.equal(endpoints.kind, 'api');
  assert.equal(endpoints.name, 'r2c-payload-0.1.0.tgz');
  assert.equal(
    endpoints.release,
    'https://api.github.com/repos/hesl2636/hm2B_drvport_pipiline/releases/tags/v0.1.0',
  );
  assert.equal(
    endpoints.asset(690847999),
    'https://api.github.com/repos/hesl2636/hm2B_drvport_pipiline/releases/assets/690847999',
  );
});

test('without a token the public release URL is used', () => {
  const endpoints = releaseEndpoints({ version: '0.1.0' });
  assert.equal(endpoints.kind, 'direct');
  assert.equal(endpoints.name, 'r2c-payload-0.1.0.tgz');
  assert.equal(
    endpoints.archive,
    'https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/v0.1.0/r2c-payload-0.1.0.tgz',
  );
  assert.equal(
    endpoints.sums,
    'https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/v0.1.0/SHA256SUMS.txt',
  );
});

test('the payload asset name is derived once for the release toolchain', () => {
  assert.equal(payloadAssetName('0.1.0'), 'r2c-payload-0.1.0.tgz');
  assert.equal(payloadAssetName('2.3.4-rc.1'), 'r2c-payload-2.3.4-rc.1.tgz');
});
