import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildComponentSet } from '../../src/domain/deploy.js';

describe('buildComponentSet', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws when packageDirectories is empty', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-'));
    await fs.writeFile(
      path.join(tmpDir, 'sfdx-project.json'),
      JSON.stringify({ packageDirectories: [] })
    );

    await expect(buildComponentSet(tmpDir)).rejects.toThrow(
      'sfdx-project.json must contain at least one packageDirectory'
    );
  });

  it('throws when packageDirectories is missing', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-'));
    await fs.writeFile(path.join(tmpDir, 'sfdx-project.json'), JSON.stringify({}));

    await expect(buildComponentSet(tmpDir)).rejects.toThrow(
      'sfdx-project.json must contain at least one packageDirectory'
    );
  });
});
