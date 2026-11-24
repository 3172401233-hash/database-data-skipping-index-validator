import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

test('CLI 读取场景文件并输出裁剪报告', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve(root, 'src/cli.js'), resolve(root, 'scenarios/example.json'), '--pretty'],
    { cwd: root },
  );

  const report = JSON.parse(stdout);
  assert.equal(report.table, 'orders');
  assert.deepEqual(report.skippableZones, ['z1']);
  assert.deepEqual(report.mustReadZones.sort(), ['z2', 'z3']);
  assert.ok(report.staleIndexEvidence.some((item) => item.kind === 'boundary_drift'));
});

test('CLI 缺少参数时以非零状态退出', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [resolve(root, 'src/cli.js')], { cwd: root }),
    (error) => error.code === 1,
  );
});
