import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDataSkipping } from '../src/engine.js';
import { makeZone, numericColumn } from './helpers.js';

function run(predicate, zones) {
  return evaluateDataSkipping({ table: 't', predicate, zones });
}

test('<> 与 NOT(col = v)：所有非 NULL 行都等于 v 且无 NULL 时才可裁剪', () => {
  const zones = [
    makeZone({
      zoneId: 'constant-no-null',
      columns: { amount: numericColumn({ min: 5, max: 5, nullCount: 0 }) },
    }),
    makeZone({
      zoneId: 'constant-with-null',
      totalRows: 100,
      columns: { amount: numericColumn({ min: 5, max: 5, nullCount: 10, nonNullRows: 90 }) },
    }),
    makeZone({
      zoneId: 'varied',
      columns: { amount: numericColumn({ min: 1, max: 10, nullCount: 0 }) },
    }),
  ];

  for (const predicate of [
    { op: 'ne', column: 'amount', value: 5 },
    { op: 'not', predicate: { op: 'eq', column: 'amount', value: 5 } },
  ]) {
    const report = run(predicate, zones);
    assert.deepEqual(report.skippableZones, ['constant-no-null']);
    assert.deepEqual(report.mustReadZones.sort(), ['constant-with-null', 'varied']);
  }
});

test('NOT (col > v)：需要所有行都满足 col > v 且无 NULL，NULL 行会阻止裁剪', () => {
  const zones = [
    makeZone({
      zoneId: 'strict-above',
      columns: { amount: numericColumn({ min: 20, max: 90, nullCount: 0 }) },
    }),
    makeZone({
      zoneId: 'strict-above-nullable',
      totalRows: 100,
      columns: { amount: numericColumn({ min: 20, max: 90, nullCount: 5, nonNullRows: 95 }) },
    }),
    makeZone({
      zoneId: 'crosses',
      columns: { amount: numericColumn({ min: 5, max: 90, nullCount: 0 }) },
    }),
  ];

  const report = run({ op: 'not', predicate: { op: 'gt', column: 'amount', value: 10 } }, zones);

  assert.deepEqual(report.skippableZones, ['strict-above']);
  assert.deepEqual(report.mustReadZones.sort(), ['crosses', 'strict-above-nullable']);
});

test('NOT (col <= v) 与 NOT BETWEEN 的推导', () => {
  const zones = [
    makeZone({
      zoneId: 'all-below',
      columns: { amount: numericColumn({ min: 1, max: 8, nullCount: 0 }) },
    }),
    makeZone({
      zoneId: 'inside-range',
      columns: { amount: numericColumn({ min: 12, max: 18, nullCount: 0 }) },
    }),
  ];

  const notLte = run(
    { op: 'not', predicate: { op: 'lte', column: 'amount', value: 10 } },
    zones,
  );
  assert.deepEqual(notLte.skippableZones, ['all-below']);

  const notBetween = run(
    { op: 'not', predicate: { op: 'between', column: 'amount', values: [10, 20] } },
    zones,
  );
  assert.deepEqual(notBetween.skippableZones, ['inside-range']);
});

test('NOT IS NULL / NOT IS NOT NULL 与双重否定', () => {
  const zones = [
    makeZone({
      zoneId: 'all-null',
      totalRows: 30,
      columns: { amount: { min: null, max: null, nullCount: 30, nonNullRows: 0, indexVersion: 1 } },
    }),
    makeZone({
      zoneId: 'no-null',
      columns: { amount: numericColumn({ min: 1, max: 5, nullCount: 0 }) },
    }),
  ];

  const notIsNull = run({ op: 'not', predicate: { op: 'isNull', column: 'amount' } }, zones);
  assert.deepEqual(notIsNull.skippableZones, ['all-null']);

  const notIsNotNull = run({ op: 'not', predicate: { op: 'isNotNull', column: 'amount' } }, zones);
  assert.deepEqual(notIsNotNull.skippableZones, ['no-null']);

  const doubleNegation = run(
    { op: 'not', predicate: { op: 'not', predicate: { op: 'eq', column: 'amount', value: 999 } } },
    zones,
  );
  assert.deepEqual(doubleNegation.skippableZones.sort(), ['all-null', 'no-null']);
});

test('NOT (a AND b) 按德摩根律等价于 NOT a OR NOT b', () => {
  const zones = [
    makeZone({
      zoneId: 'both-constant',
      columns: {
        amount: numericColumn({ min: 5, max: 5, nullCount: 0 }),
        qty: numericColumn({ min: 7, max: 7, nullCount: 0 }),
      },
    }),
    makeZone({
      zoneId: 'only-amount-constant',
      columns: {
        amount: numericColumn({ min: 5, max: 5, nullCount: 0 }),
        qty: numericColumn({ min: 1, max: 9, nullCount: 0 }),
      },
    }),
  ];

  const report = run(
    {
      op: 'not',
      predicate: {
        op: 'and',
        predicates: [
          { op: 'eq', column: 'amount', value: 5 },
          { op: 'eq', column: 'qty', value: 7 },
        ],
      },
    },
    zones,
  );

  assert.deepEqual(report.skippableZones, ['both-constant']);
  assert.deepEqual(report.mustReadZones, ['only-amount-constant']);
});
