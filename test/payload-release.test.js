import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseEndpoints } from '../src/adapter/payload.js';

test('a token routes the payload download through the GitHub API', () => {
  const endpoints = releaseEndpoints({ version: '0.1.0', asset: 'r2c-plugin-0.1.0.tgz', token: 'x' });
  assert.equal(endpoints.kind, 'api');
  assert.equal(
    endpoints.release,
    'https://api.github.com/repos/hesl2636/RTOSv3_R2C_pipiline/releases/tags/v0.1.0',
  );
  assert.equal(
    endpoints.asset(690847999),
    'https://api.github.com/repos/hesl2636/RTOSv3_R2C_pipiline/releases/assets/690847999',
  );
});

test('without a token the public release URL is used', () => {
  const endpoints = releaseEndpoints({ version: '0.1.0', asset: 'r2c-plugin-0.1.0.tgz' });
  assert.equal(endpoints.kind, 'direct');
  assert.equal(
    endpoints.archive,
    'https://github.com/hesl2636/RTOSv3_R2C_pipiline/releases/download/v0.1.0/r2c-plugin-0.1.0.tgz',
  );
  assert.equal(
    endpoints.sums,
    'https://github.com/hesl2636/RTOSv3_R2C_pipiline/releases/download/v0.1.0/SHA256SUMS.txt',
  );
});
