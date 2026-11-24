import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDataSkipping } from '../src/engine.js';
import { makeZone, numericColumn, kindsFor } from './helpers.js';

function run(predicate, zones) {
  return evaluateDataSkipping({ table: 't', predicate, zones });
}

test('显式损坏标记：该区域必须读取，其他区域正常裁剪', () => {
  const zones = [
    makeZone({
      zoneId: 'good',
      columns: { amount: numericColumn({ min: 1, max: 99 }) },
    }),
    makeZone({
      zoneId: 'bad',
      columns: { amount: numericColumn({ min: 1, max: 99, corrupted: true }) },
    }),
  ];

  const report = run({ op: 'eq', column: 'amount', value: 250 }, zones);

  assert.deepEqual(report.skippableZones, ['good']);
  assert.deepEqual(report.mustReadZones, ['bad']);
  assert.deepEqual(kindsFor(report, 'bad'), ['corrupt_stats']);
});

test('min/max 倒置被识别为损坏统计', () => {
  const zones = [
    makeZone({
      zoneId: 'inverted',
      columns: { amount: numericColumn({ min: 100, max: 10 }) },
    }),
  ];

  const report = run({ op: 'eq', column: 'amount', value: 250 }, zones);

  assert.deepEqual(report.mustReadZones, ['inverted']);
  assert.deepEqual(kindsFor(report, 'inverted'), ['corrupt_stats']);
  assert.match(report.staleIndexEvidence[0].detail, /倒置/);
});

test('NULL 与非 NULL 计数之和不等于总行数时判定损坏', () => {
  const zones = [
    makeZone({
      zoneId: 'bad-count',
      totalRows: 100,
      columns: { amount: numericColumn({ min: 1, max: 10, nullCount: 5, nonNullRows: 80 }) },
    }),
  ];

  const report = run({ op: 'gt', column: 'amount', value: 5 }, zones);

  assert.deepEqual(report.mustReadZones, ['bad-count']);
  assert.deepEqual(kindsFor(report, 'bad-count'), ['corrupt_stats']);
});

test('谓词列统计缺失：missing_stats 证据，绝不裁剪', () => {
  const zones = [
    makeZone({
      zoneId: 'no-stats',
      columns: { other: numericColumn({ min: 0, max: 1 }) },
    }),
  ];

  const report = run({ op: 'eq', column: 'amount', value: 250 }, zones);

  assert.deepEqual(report.mustReadZones, ['no-stats']);
  assert.deepEqual(kindsFor(report, 'no-stats'), ['missing_stats']);
});

test('部分损坏只影响损坏区域，AND 谓词中另一列损坏同样阻断裁剪', () => {
  const zones = [
    makeZone({
      zoneId: 'one-bad-column',
      columns: {
        amount: numericColumn({ min: 1, max: 99 }),
        qty: numericColumn({ min: 0, max: 1, corrupted: true }),
      },
    }),
    makeZone({
      zoneId: 'all-good',
      columns: {
        amount: numericColumn({ min: 1, max: 99 }),
        qty: numericColumn({ min: 10, max: 20 }),
      },
    }),
  ];

  const report = run(
    {
      op: 'and',
      predicates: [
        { op: 'eq', column: 'amount', value: 250 },
        { op: 'gt', column: 'qty', value: 5 },
      ],
    },
    zones,
  );

  assert.deepEqual(report.skippableZones, ['all-good']);
  assert.deepEqual(report.mustReadZones, ['one-bad-column']);
  assert.deepEqual(kindsFor(report, 'one-bad-column'), ['corrupt_stats']);
});
