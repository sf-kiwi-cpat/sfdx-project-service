import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProjectWatcher } from './events.js';

describe('createProjectWatcher', () => {
  let tmpDir: string;
  let originalProjectRoot: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-project-events-'));
    originalProjectRoot = process.env.PROJECT_ROOT;
    process.env.PROJECT_ROOT = tmpDir;
  });

  afterEach(async () => {
    process.env.PROJECT_ROOT = originalProjectRoot;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('emits add event with path relative to project root', async () => {
    await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default'), { recursive: true });

    const events: Array<{ type: string; path: string }> = [];
    const watcher = createProjectWatcher((e) => events.push(e));

    // Wait for watcher to be ready
    await new Promise((r) => setTimeout(r, 100));
    await fs.writeFile(path.join(tmpDir, 'force-app', 'main', 'default', 'Foo.cls'), 'class Foo {}');

    await new Promise((r) => setTimeout(r, 200));
    watcher.close();

    const addEvents = events.filter((e) => e.type === 'add' && e.path.includes('Foo.cls'));
    expect(addEvents.length).toBeGreaterThan(0);
    expect(addEvents[0].path.replace(/\\/g, '/')).toBe('force-app/main/default/Foo.cls');
  });

  it('emits change event when file is modified', async () => {
    await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'force-app', 'main', 'default', 'Bar.cls'), 'v1');

    const events: Array<{ type: string; path: string }> = [];
    const watcher = createProjectWatcher((e) => events.push(e));

    await new Promise((r) => setTimeout(r, 50));
    await fs.writeFile(path.join(tmpDir, 'force-app', 'main', 'default', 'Bar.cls'), 'v2');

    await new Promise((r) => setTimeout(r, 150));
    watcher.close();

    expect(events.some((e) => e.type === 'change' && e.path === 'force-app/main/default/Bar.cls')).toBe(true);
  });

  it('emits unlink event when file is deleted', async () => {
    await fs.mkdir(path.join(tmpDir, 'force-app', 'main', 'default'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'force-app', 'main', 'default', 'Baz.cls'), 'content');

    const events: Array<{ type: string; path: string }> = [];
    const watcher = createProjectWatcher((e) => events.push(e));

    await new Promise((r) => setTimeout(r, 50));
    await fs.unlink(path.join(tmpDir, 'force-app', 'main', 'default', 'Baz.cls'));

    await new Promise((r) => setTimeout(r, 150));
    watcher.close();

    expect(events.some((e) => e.type === 'unlink' && e.path === 'force-app/main/default/Baz.cls')).toBe(true);
  });

  it('does not emit events for ignored paths (.git, .sf, node_modules)', async () => {
    const events: Array<{ type: string; path: string }> = [];
    const watcher = createProjectWatcher((e) => events.push(e));

    await new Promise<void>((resolve) => watcher.on('ready', resolve));

    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.sf'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });

    await fs.writeFile(path.join(tmpDir, '.git', 'config'), 'content');
    await fs.writeFile(path.join(tmpDir, '.sf', 'auth.json'), '{}');
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'x');

    await new Promise((r) => setTimeout(r, 150));
    watcher.close();

    expect(events.filter((e) => e.path.includes('.git') || e.path.includes('.sf') || e.path.includes('node_modules'))).toHaveLength(0);
  });

  it('can be closed cleanly', async () => {
    const watcher = createProjectWatcher(() => {});
    watcher.close();
    // No throw — closed successfully
  });
});
