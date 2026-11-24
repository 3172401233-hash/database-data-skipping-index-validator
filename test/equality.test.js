import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDataSkipping } from '../src/engine.js';
import { makeZone, numericColumn } from './helpers.js';

function run(predicate, zones) {
  return evaluateDataSkipping({ table: 't', predicate, zones });
}

test('等值谓词：值在 min-max 之外时安全跳过，之内时必须读取', () => {
  const zones = [
    makeZone({
      zoneId: 'outside',
      columns: { amount: numericColumn({ min: 1, max: 99 }) },
    }),
    makeZone({
      zoneId: 'inside',
      columns: { amount: numericColumn({ min: 200, max: 300 }) },
    }),
  ];

  const report = run({ op: 'eq', column: 'amount', value: 250 }, zones);

  assert.deepEqual(report.skippableZones, ['outside']);
  assert.deepEqual(report.mustReadZones, ['inside']);
  assert.equal(report.summary.skippableCount, 1);
  assert.equal(report.summary.mustReadCount, 1);
});

test('等值 NULL：依赖 NULL 计数，无 NULL 的区域可跳过', () => {
  const zones = [
    makeZone({
      zoneId: 'no-nulls',
      columns: { amount: numericColumn({ min: 1, max: 10, nullCount: 0 }) },
    }),
    makeZone({
      zoneId: 'has-nulls',
      totalRows: 100,
      columns: { amount: numericColumn({ min: 1, max: 10, nullCount: 5, nonNullRows: 95 }) },
    }),
  ];

  const report = run({ op: 'eq', column: 'amount', value: null }, zones);

  assert.deepEqual(report.skippableZones, ['no-nulls']);
  assert.deepEqual(report.mustReadZones, ['has-nulls']);
});

test('等值谓词：类型不一致时保守读取而不是裁剪', () => {
  const zones = [
    makeZone({
      zoneId: 'typed',
      columns: { amount: numericColumn({ min: 1, max: 99 }) },
    }),
  ];

  const report = run({ op: 'eq', column: 'amount', value: '50' }, zones);

  assert.deepEqual(report.mustReadZones, ['typed']);
  assert.match(report.zoneDecisions[0].reason, /类型不一致/);
});

test('字符串等值：按字典序 min-max 判断', () => {
  const zones = [
    makeZone({
      zoneId: 'a-range',
      columns: {
        status: { min: 'archived', max: 'closed', nullCount: 0, nonNullRows: 100, indexVersion: 1 },
      },
    }),
    makeZone({
      zoneId: 'p-range',
      columns: {
        status: { min: 'open', max: 'pending', nullCount: 0, nonNullRows: 100, indexVersion: 1 },
      },
    }),
  ];

  const report = run({ op: 'eq', column: 'status', value: 'paid' }, zones);

  assert.deepEqual(report.skippableZones, ['a-range']);
  assert.deepEqual(report.mustReadZones, ['p-range']);
});
