import { canSkip, getReferencedColumns } from './predicate.js';
import { collectIndexEvidence } from './stale.js';

const VALID_OPS = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'isNull',
  'isNotNull',
  'and',
  'or',
  'not',
]);

function validatePredicate(predicate, path = 'predicate') {
  if (!predicate || typeof predicate !== 'object') {
    throw new Error(`${path} 必须是对象`);
  }
  if (!VALID_OPS.has(predicate.op)) {
    throw new Error(`${path} 使用了不支持的操作符: ${predicate.op}`);
  }
  if (predicate.op === 'and' || predicate.op === 'or') {
    if (!Array.isArray(predicate.predicates) || predicate.predicates.length === 0) {
      throw new Error(`${path}(${predicate.op}) 需要非空的 predicates 数组`);
    }
    predicate.predicates.forEach((child, index) => validatePredicate(child, `${path}.predicates[${index}]`));
    return;
  }
  if (predicate.op === 'not') {
    if (!predicate.predicate) {
      throw new Error(`${path}(not) 需要内层 predicate`);
    }
    validatePredicate(predicate.predicate, `${path}.predicate`);
    return;
  }
  if (predicate.op === 'between') {
    if (!predicate.column || !Array.isArray(predicate.values) || predicate.values.length !== 2) {
      throw new Error(`${path}(between) 需要 column 和长度为 2 的 values`);
    }
    return;
  }
  if (predicate.op === 'isNull' || predicate.op === 'isNotNull') {
    if (!predicate.column) {
      throw new Error(`${path}(${predicate.op}) 需要 column`);
    }
    return;
  }
  if (!predicate.column || predicate.value === undefined) {
    throw new Error(`${path}(${predicate.op}) 需要 column 和 value`);
  }
}

function validateZone(zone) {
  if (!zone || typeof zone !== 'object' || !zone.zoneId) {
    throw new Error('每个区域必须包含 zoneId');
  }
  if (!Number.isInteger(zone.totalRows) || zone.totalRows < 0) {
    throw new Error(`区域 ${zone.zoneId} 的 totalRows 必须是非负整数`);
  }
  if (!Number.isInteger(zone.pageVersion) || zone.pageVersion < 0) {
    throw new Error(`区域 ${zone.zoneId} 的 pageVersion 必须是非负整数`);
  }
  if (!zone.columns || typeof zone.columns !== 'object') {
    throw new Error(`区域 ${zone.zoneId} 必须包含 columns 统计`);
  }
}

// 主入口：输入区域边界、min-max、NULL 计数、行版本、更新日志和查询谓词，
// 输出每个区域能否安全跳过，以及过期索引证据。纯内存计算，不连接数据库。
export function evaluateDataSkipping(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('输入必须是对象');
  }
  const { table, predicate, zones, changeLog = [] } = input;
  if (!table) {
    throw new Error('输入缺少 table 标识');
  }
  if (!predicate) {
    throw new Error('输入缺少查询谓词 predicate');
  }
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new Error('输入缺少非空的 zones 数组');
  }
  validatePredicate(predicate);
  zones.forEach(validateZone);

  const predicateColumns = getReferencedColumns(predicate);
  const decisions = zones.map((zone) => {
    const evidence = collectIndexEvidence(zone, predicateColumns, changeLog);

    if (evidence.length > 0) {
      return {
        zoneId: zone.zoneId,
        decision: 'must_read',
        safeToSkip: false,
        reason: '索引不可信（缺失/损坏/落后于数据页），禁止裁剪，必须读取数据页',
        indexEvidence: evidence,
      };
    }

    const verdict = canSkip(predicate, zone);
    return {
      zoneId: zone.zoneId,
      decision: verdict.skip ? 'skippable' : 'must_read',
      safeToSkip: verdict.skip,
      reason: verdict.reason,
      indexEvidence: [],
    };
  });

  const skippableZones = decisions.filter((d) => d.safeToSkip).map((d) => d.zoneId);
  const mustReadZones = decisions.filter((d) => !d.safeToSkip).map((d) => d.zoneId);
  const staleZones = [
    ...new Set(
      decisions
        .filter((d) => d.indexEvidence.length > 0)
        .map((d) => d.zoneId),
    ),
  ];

  return {
    table,
    predicate,
    summary: {
      totalZones: zones.length,
      skippableCount: skippableZones.length,
      mustReadCount: mustReadZones.length,
      staleIndexZones: staleZones,
    },
    skippableZones,
    mustReadZones,
    staleIndexEvidence: decisions
      .filter((d) => d.indexEvidence.length > 0)
      .flatMap((d) => d.indexEvidence),
    zoneDecisions: decisions,
  };
}
