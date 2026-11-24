import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDataSkipping } from '../src/engine.js';
import { makeZone, numericColumn } from './helpers.js';

function run(predicate, zones) {
  return evaluateDataSkipping({ table: 't', predicate, zones });
}

test('gt / gte 的边界推导', () => {
  const zones = [
    makeZone({
      zoneId: 'max-equals',
      columns: { amount: numericColumn({ min: 1, max: 100 }) },
    }),
    makeZone({
      zoneId: 'above',
      columns: { amount: numericColumn({ min: 200, max: 300 }) },
    }),
  ];

  const gt = run({ op: 'gt', column: 'amount', value: 100 }, zones);
  assert.deepEqual(gt.skippableZones, ['max-equals']);
  assert.deepEqual(gt.mustReadZones, ['above']);

  const gte = run({ op: 'gte', column: 'amount', value: 101 }, zones);
  assert.deepEqual(gte.skippableZones, ['max-equals']);
  assert.deepEqual(gte.mustReadZones, ['above']);

  const gteBoundary = run({ op: 'gte', column: 'amount', value: 100 }, zones);
  assert.deepEqual(gteBoundary.mustReadZones.sort(), ['above', 'max-equals']);
});

test('lt / lte 的边界推导', () => {
  const zones = [
    makeZone({
      zoneId: 'min-equals',
      columns: { amount: numericColumn({ min: 100, max: 200 }) },
    }),
    makeZone({
      zoneId: 'below',
      columns: { amount: numericColumn({ min: 1, max: 50 }) },
    }),
  ];

  const lt = run({ op: 'lt', column: 'amount', value: 100 }, zones);
  assert.deepEqual(lt.skippableZones, ['min-equals']);

  const lte = run({ op: 'lte', column: 'amount', value: 99 }, zones);
  assert.deepEqual(lte.skippableZones, ['min-equals']);

  const lteBoundary = run({ op: 'lte', column: 'amount', value: 100 }, zones);
  assert.deepEqual(lteBoundary.mustReadZones.sort(), ['below', 'min-equals']);
});

test('between：区间与 min-max 无交集时裁剪，有交集时读取', () => {
  const zones = [
    makeZone({
      zoneId: 'disjoint-low',
      columns: { amount: numericColumn({ min: 1, max: 50 }) },
    }),
    makeZone({
      zoneId: 'disjoint-high',
      columns: { amount: numericColumn({ min: 400, max: 500 }) },
    }),
    makeZone({
      zoneId: 'overlap',
      columns: { amount: numericColumn({ min: 80, max: 150 }) },
    }),
    makeZone({
      zoneId: 'touching',
      columns: { amount: numericColumn({ min: 100, max: 200 }) },
    }),
  ];

  const report = run(
    { op: 'between', column: 'amount', values: [100, 300] },
    zones,
  );

  assert.deepEqual(report.skippableZones.sort(), ['disjoint-high', 'disjoint-low']);
  assert.deepEqual(report.mustReadZones.sort(), ['overlap', 'touching']);
});

test('范围谓词同样受 NULL 影响：NULL 行无法被不等式匹配但 min-max 推导仍然成立', () => {
  const zones = [
    makeZone({
      zoneId: 'all-below-with-nulls',
      totalRows: 100,
      columns: { amount: numericColumn({ min: 1, max: 50, nullCount: 20, nonNullRows: 80 }) },
    }),
  ];

  const report = run({ op: 'gt', column: 'amount', value: 60 }, zones);

  assert.deepEqual(report.skippableZones, ['all-below-with-nulls']);
});
