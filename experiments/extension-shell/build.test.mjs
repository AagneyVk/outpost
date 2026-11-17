import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { collectBlobs } from './linux-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
test('extension builder refuses to overwrite an existing directory', async () => {
  const temporary = await fs.mkdtemp(path.join(here, 'temporary-build-'));
  try {
    const output = path.join(temporary, 'existing');
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, 'keep.txt'), 'preserve');
    await assert.rejects(execFileAsync(process.execPath, [path.join(here, 'build.mjs'), '--out', output]), /EEXIST/);
    assert.equal(await fs.readFile(path.join(output, 'keep.txt'), 'utf8'), 'preserve');
    assert.deepEqual(await fs.readdir(output), ['keep.txt']);
  } finally {
    if (path.dirname(temporary) !== here) throw Error('Invalid temporary path');
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});

test('Linux runtime manifest accepts only content-addressed regular-file blobs', () => {
  const file = name => ['file', 1, 0, 0x8000, 0, 0, name];
  const directory = children => ['dir', 0, 0, 0x4000, 0, 0, children];
  assert.deepEqual(collectBlobs({ fsroot: [directory([file('0123456789.bin'), file('0123456789.bin')])] }), ['0123456789.bin']);
  for (const bad of ['../0123456789.bin', '0123456789.bin/../evil', '012345678X.bin', '0123456789']) {
    assert.throws(() => collectBlobs({ fsroot: [file(bad)] }), /Invalid Linux blob name/);
  }
  assert.throws(() => collectBlobs({ fsroot: [directory('bad')] }), /Invalid Linux directory/);
  assert.throws(() => collectBlobs({}), /Invalid Linux filesystem manifest/);
});
