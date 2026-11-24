import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateDataSkipping } from '../src/engine.js';
import { makeZone, numericColumn, kindsFor } from './helpers.js';

function run(predicate, zones, changeLog = []) {
  return evaluateDataSkipping({ table: 't', predicate, zones, changeLog });
}

test('索引版本落后于数据页版本：禁止裁剪并给出 stale_version 证据', () => {
  const zones = [
    makeZone({
      zoneId: 'stale',
      pageVersion: 3,
      rowVersion: 3,
      columns: { amount: numericColumn({ min: 1, max: 99, indexVersion: 1 }) },
    }),
    makeZone({
      zoneId: 'fresh',
      pageVersion: 3,
      rowVersion: 3,
      columns: { amount: numericColumn({ min: 1, max: 99, indexVersion: 3 }) },
    }),
  ];

  const report = run({ op: 'eq', column: 'amount', value: 250 }, zones);

  assert.deepEqual(report.mustReadZones, ['stale']);
  assert.deepEqual(report.skippableZones, ['fresh']);
  assert.deepEqual(report.summary.staleIndexZones, ['stale']);
  assert.deepEqual(kindsFor(report, 'stale'), ['stale_version']);
});

test('行版本高于索引版本同样判定为过期（部分行更新）', () => {
  const zones = [
    makeZone({
      zoneId: 'row-updated',
      pageVersion: 2,
      rowVersion: 4,
      columns: { amount: numericColumn({ min: 1, max: 99, indexVersion: 2 }) },
    }),
  ];

  const report = run({ op: 'eq', column: 'amount', value: 250 }, zones);

  assert.deepEqual(report.mustReadZones, ['row-updated']);
  assert.deepEqual(kindsFor(report, 'row-updated'), ['stale_version']);
});

test('更新日志显示谓词列被更新且索引停留在更新前：changelog_mismatch 证据', () => {
  const zones = [
    makeZone({
      zoneId: 'z2',
      pageVersion: 2,
      columns: { amount: numericColumn({ min: 1, max: 99, indexVersion: 1 }) },
    }),
  ];
  const changeLog = [
    {
      zoneId: 'z2',
      operation: 'UPDATE',
      columns: ['amount'],
      pageVersionBefore: 1,
      pageVersionAfter: 2,
    },
  ];

  const report = run({ op: 'eq', column: 'amount', value: 250 }, zones, changeLog);

  assert.deepEqual(kindsFor(report, 'z2').sort(), ['changelog_mismatch', 'stale_version']);
  const evidence = report.staleIndexEvidence.find((item) => item.kind === 'changelog_mismatch');
  assert.equal(evidence.column, 'amount');
  assert.match(evidence.detail, /UPDATE/);
});

test('数据页真实边界与索引边界不一致：boundary_drift 直接证明旧索引会误裁剪', () => {
  const zones = [
    makeZone({
      zoneId: 'z2',
      pageVersion: 2,
      columns: { amount: numericColumn({ min: 1, max: 99, indexVersion: 1 }) },
      pageStats: { amount: { min: 1, max: 250 } },
    }),
  ];

  const report = run({ op: 'eq', column: 'amount', value: 250 }, zones);

  assert.deepEqual(report.mustReadZones, ['z2']);
  assert.deepEqual(kindsFor(report, 'z2').sort(), ['boundary_drift', 'stale_version']);
  const drift = report.staleIndexEvidence.find((item) => item.kind === 'boundary_drift');
  assert.deepEqual(drift.indexedMinMax, [1, 99]);
  assert.deepEqual(drift.actualMinMax, [1, 250]);
});

test('端到端复现：更新改变边界后，仅依赖旧 zone map 会错误跳过真实命中区域', async () => {
  const raw = await readFile(new URL('../scenarios/example.json', import.meta.url), 'utf8');
  const input = JSON.parse(raw);

  const report = evaluateDataSkipping(input);

  // 朴素裁剪会把 z2 与 z1 一起跳过；正确行为是 z2 必须读取
  assert.deepEqual(report.skippableZones, ['z1']);
  assert.deepEqual(report.mustReadZones.sort(), ['z2', 'z3']);
  assert.deepEqual(report.summary.staleIndexZones, ['z2']);
  const kinds = kindsFor(report, 'z2');
  assert.ok(kinds.includes('stale_version'));
  assert.ok(kinds.includes('changelog_mismatch'));
  assert.ok(kinds.includes('boundary_drift'));
});

test('未被谓词引用的列过期不影响裁剪，仅谓词列的状态决定可读性', () => {
  const zones = [
    makeZone({
      zoneId: 'z1',
      pageVersion: 3,
      columns: {
        amount: numericColumn({ min: 1, max: 99, indexVersion: 3 }),
        note: numericColumn({ min: 0, max: 1, indexVersion: 1 }),
      },
    }),
  ];

  const report = run({ op: 'eq', column: 'amount', value: 250 }, zones);

  assert.deepEqual(report.skippableZones, ['z1']);
  assert.deepEqual(report.staleIndexEvidence, []);
});
