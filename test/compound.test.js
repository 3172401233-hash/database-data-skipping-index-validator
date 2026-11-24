import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDataSkipping } from '../src/engine.js';
import { makeZone, numericColumn } from './helpers.js';

function run(predicate, zones) {
  return evaluateDataSkipping({ table: 't', predicate, zones });
}

test('AND：任一子谓词可裁剪则整个区域可裁剪', () => {
  const zones = [
    makeZone({
      zoneId: 'amount-excludes',
      columns: {
        amount: numericColumn({ min: 1, max: 99 }),
        qty: numericColumn({ min: 1, max: 5 }),
      },
    }),
    makeZone({
      zoneId: 'both-maybe',
      columns: {
        amount: numericColumn({ min: 200, max: 300 }),
        qty: numericColumn({ min: 1, max: 10 }),
      },
    }),
  ];

  const report = run(
    {
      op: 'and',
      predicates: [
        { op: 'eq', column: 'amount', value: 250 },
        { op: 'gt', column: 'qty', value: 3 },
      ],
    },
    zones,
  );

  assert.deepEqual(report.skippableZones, ['amount-excludes']);
  assert.deepEqual(report.mustReadZones, ['both-maybe']);
});

test('OR：所有子谓词都可裁剪时才可裁剪', () => {
  const zones = [
    makeZone({
      zoneId: 'both-exclude',
      columns: {
        amount: numericColumn({ min: 1, max: 99 }),
        qty: numericColumn({ min: 1, max: 4 }),
      },
    }),
    makeZone({
      zoneId: 'one-includes',
      columns: {
        amount: numericColumn({ min: 200, max: 300 }),
        qty: numericColumn({ min: 1, max: 4 }),
      },
    }),
  ];

  const report = run(
    {
      op: 'or',
      predicates: [
        { op: 'eq', column: 'amount', value: 250 },
        { op: 'gt', column: 'qty', value: 10 },
      ],
    },
    zones,
  );

  assert.deepEqual(report.skippableZones, ['both-exclude']);
  assert.deepEqual(report.mustReadZones, ['one-includes']);
});

test('非法输入抛出可诊断的错误', () => {
  assert.throws(
    () =>
      evaluateDataSkipping({
        table: 't',
        predicate: { op: 'regex', column: 'a' },
        zones: [
          makeZone({
            zoneId: 'z',
            columns: { a: numericColumn({ min: 1, max: 2 }) },
          }),
        ],
      }),
    /不支持的操作符/,
  );
  assert.throws(
    () =>
      evaluateDataSkipping({
        table: 't',
        predicate: { op: 'eq', column: 'a', value: 1 },
        zones: [],
      }),
    /zones/,
  );
  assert.throws(
    () =>
      evaluateDataSkipping({
        table: 't',
        predicate: { op: 'eq', column: 'a', value: 1 },
        zones: [{ zoneId: 'z', totalRows: -1, pageVersion: 1, columns: {} }],
      }),
    /totalRows/,
  );
});
