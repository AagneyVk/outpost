import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

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
