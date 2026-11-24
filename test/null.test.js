import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDataSkipping } from '../src/engine.js';
import { makeZone, numericColumn } from './helpers.js';

function run(predicate, zones) {
  return evaluateDataSkipping({ table: 't', predicate, zones });
}

test('IS NULL：按 NULL 计数裁剪', () => {
  const zones = [
    makeZone({
      zoneId: 'dense',
      columns: { amount: numericColumn({ min: 1, max: 10, nullCount: 0 }) },
    }),
    makeZone({
      zoneId: 'sparse',
      totalRows: 100,
      columns: { amount: numericColumn({ min: 1, max: 10, nullCount: 30, nonNullRows: 70 }) },
    }),
  ];

  const report = run({ op: 'isNull', column: 'amount' }, zones);

  assert.deepEqual(report.skippableZones, ['dense']);
  assert.deepEqual(report.mustReadZones, ['sparse']);
});

test('IS NOT NULL：全 NULL 区域（min/max 均为空）可裁剪', () => {
  const zones = [
    makeZone({
      zoneId: 'all-null',
      totalRows: 40,
      columns: {
        amount: { min: null, max: null, nullCount: 40, nonNullRows: 0, indexVersion: 1 },
      },
    }),
    makeZone({
      zoneId: 'mixed',
      totalRows: 40,
      columns: {
        amount: { min: 1, max: 9, nullCount: 10, nonNullRows: 30, indexVersion: 1 },
      },
    }),
  ];

  const report = run({ op: 'isNotNull', column: 'amount' }, zones);

  assert.deepEqual(report.skippableZones, ['all-null']);
  assert.deepEqual(report.mustReadZones, ['mixed']);
});

test('空区域对任意谓词都安全跳过', () => {
  const zones = [
    makeZone({
      zoneId: 'empty',
      totalRows: 0,
      columns: {
        amount: { min: null, max: null, nullCount: 0, nonNullRows: 0, indexVersion: 1 },
      },
    }),
  ];

  const report = run({ op: 'isNull', column: 'amount' }, zones);

  assert.deepEqual(report.skippableZones, ['empty']);
});
