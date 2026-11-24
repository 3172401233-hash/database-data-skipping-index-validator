// 谓词级别的 zone map 裁剪推导。
//
// 约定：
//   canSkip(p, zone)   —— zone 内不可能存在满足 p 的行（保守判断，拿不准就不裁剪）
//   allRowsMatch(p, z) —— zone 内每一行（NULL 行除外，由调用方另行处理）都满足 p，
//                         用于推导否定谓词 NOT p

function referencedColumns(predicate, columns = new Set()) {
  if (predicate && typeof predicate === 'object' && predicate.column) {
    columns.add(predicate.column);
  }
  if (predicate && Array.isArray(predicate.predicates)) {
    for (const child of predicate.predicates) {
      referencedColumns(child, columns);
    }
  }
  if (predicate && predicate.predicate) {
    referencedColumns(predicate.predicate, columns);
  }
  return columns;
}

export function getReferencedColumns(predicate) {
  return [...referencedColumns(predicate)];
}

function comparable(zone, value) {
  if (zone.min == null || zone.max == null || value == null) {
    return false;
  }
  return typeof zone.min === typeof value && typeof zone.max === typeof value;
}

function allNonNullRowsEqual(zone, value) {
  return (
    zone.nonNullRows > 0 &&
    zone.min === value &&
    zone.max === value &&
    zone.nullCount === 0
  );
}

// zone 里是否可能存在满足 p 的行；返回 { skip, reason }
export function canSkip(predicate, zone) {
  if (!predicate || !predicate.op) {
    return { skip: false, reason: '谓词格式无法识别，保守读取' };
  }

  if (zone.totalRows === 0) {
    return { skip: true, reason: '区域无数据行' };
  }

  switch (predicate.op) {
    case 'and': {
      for (const child of predicate.predicates) {
        const verdict = canSkip(child, zone);
        if (verdict.skip) {
          return {
            skip: true,
            reason: `AND 子谓词可裁剪（${verdict.reason}）`,
          };
        }
      }
      return { skip: false, reason: 'AND 各子谓词均无法单独排除该区域' };
    }

    case 'or': {
      for (const child of predicate.predicates) {
        if (!canSkip(child, zone).skip) {
          return { skip: false, reason: 'OR 中存在无法排除的子谓词' };
        }
      }
      return { skip: true, reason: 'OR 的所有子谓词都可裁剪' };
    }

    case 'not':
      return canSkipNegated(predicate.predicate, zone);

    default:
      return canSkipLeaf(predicate, zone);
  }
}

function canSkipLeaf(predicate, zone) {
  const { op, column, value } = predicate;
  const stats = zone.columns[column];

  if (!stats) {
    return { skip: false, reason: `列 ${column} 缺少 zone 统计，保守读取` };
  }

  switch (op) {
    case 'eq': {
      if (value === null) {
        if (stats.nullCount === 0) {
          return { skip: true, reason: `${column} 的 NULL 计数为 0，col = NULL 无匹配` };
        }
        return { skip: false, reason: `${column} 存在 ${stats.nullCount} 个 NULL 行` };
      }
      if (stats.nonNullRows === 0) {
        return { skip: true, reason: `${column} 全部为 NULL 行，等值 ${value} 无匹配` };
      }
      if (!comparable(stats, value)) {
        return { skip: false, reason: `${column} 与字面量类型不一致，保守读取` };
      }
      if (value < stats.min || value > stats.max) {
        return {
          skip: true,
          reason: `等值 ${value} 落在 min-max [${stats.min}, ${stats.max}] 之外`,
        };
      }
      return { skip: false, reason: `等值 ${value} 位于 min-max [${stats.min}, ${stats.max}] 内` };
    }

    case 'ne': {
      // col <> value：只有当所有非 NULL 行都等于 value，且不存在 NULL 行时才可裁剪
      if (stats.nonNullRows === 0) {
        return { skip: true, reason: `全部为 NULL 行，col <> ${value} 无匹配` };
      }
      if (allNonNullRowsEqual(stats, value)) {
        return {
          skip: true,
          reason: `所有非 NULL 行均等于 ${value} 且无 NULL 行，col <> ${value} 无匹配`,
        };
      }
      return { skip: false, reason: `区域内可能存在不等于 ${value} 的行（或 NULL 行）` };
    }

    case 'gt': {
      if (!comparable(stats, value)) {
        return { skip: false, reason: `${column} 与字面量类型不一致，保守读取` };
      }
      if (stats.max <= value) {
        return { skip: true, reason: `最大值 ${stats.max} <= ${value}，col > ${value} 无匹配` };
      }
      return { skip: false, reason: `最大值 ${stats.max} > ${value}，可能存在匹配行` };
    }

    case 'gte': {
      if (!comparable(stats, value)) {
        return { skip: false, reason: `${column} 与字面量类型不一致，保守读取` };
      }
      if (stats.max < value) {
        return { skip: true, reason: `最大值 ${stats.max} < ${value}，col >= ${value} 无匹配` };
      }
      return { skip: false, reason: `最大值 ${stats.max} >= ${value}，可能存在匹配行` };
    }

    case 'lt': {
      if (!comparable(stats, value)) {
        return { skip: false, reason: `${column} 与字面量类型不一致，保守读取` };
      }
      if (stats.min >= value) {
        return { skip: true, reason: `最小值 ${stats.min} >= ${value}，col < ${value} 无匹配` };
      }
      return { skip: false, reason: `最小值 ${stats.min} < ${value}，可能存在匹配行` };
    }

    case 'lte': {
      if (!comparable(stats, value)) {
        return { skip: false, reason: `${column} 与字面量类型不一致，保守读取` };
      }
      if (stats.min > value) {
        return { skip: true, reason: `最小值 ${stats.min} > ${value}，col <= ${value} 无匹配` };
    }
      return { skip: false, reason: `最小值 ${stats.min} <= ${value}，可能存在匹配行` };
    }

    case 'between': {
      const [low, high] = predicate.values ?? [];
      if (low == null || high == null || !comparable(stats, low) || !comparable(stats, high)) {
        return { skip: false, reason: `BETWEEN 边界缺失或类型不一致，保守读取` };
      }
      if (stats.max < low || stats.min > high) {
        return {
          skip: true,
          reason: `min-max [${stats.min}, ${stats.max}] 与 BETWEEN [${low}, ${high}] 无交集`,
        };
      }
      return {
        skip: false,
        reason: `min-max [${stats.min}, ${stats.max}] 与 BETWEEN [${low}, ${high}] 有交集`,
      };
    }

    case 'isNull': {
      if (stats.nullCount === 0) {
        return { skip: true, reason: `${column} 的 NULL 计数为 0，IS NULL 无匹配` };
      }
      return { skip: false, reason: `${column} 存在 ${stats.nullCount} 个 NULL 行，IS NULL 可能匹配` };
    }

    case 'isNotNull': {
      if (stats.nonNullRows === 0) {
        return {
          skip: true,
          reason: `${column} 非 NULL 计数为 0（全部为 NULL），IS NOT NULL 无匹配`,
        };
      }
      return { skip: false, reason: `${column} 存在 ${stats.nonNullRows} 个非 NULL 行` };
    }

    default:
      return { skip: false, reason: `不支持的谓词操作符 ${op}，保守读取` };
  }
}

// 处理 NOT p：p 在 zone 中对每一行都成立时，NOT p 才可裁剪
function canSkipNegated(inner, zone) {
  if (zone.totalRows === 0) {
    return { skip: true, reason: '区域无数据行' };
  }

  if (inner.op === 'and' || inner.op === 'or') {
    // NOT (a AND b) = NOT a OR NOT b：所有否定子句都可裁剪时才可裁剪
    // NOT (a OR b)  = NOT a AND NOT b：任一否定子句可裁剪即可裁剪
    const operator = inner.op === 'and' ? 'or' : 'and';
    return canSkip({ op: operator, predicates: inner.predicates.map((p) => ({ op: 'not', predicate: p })) }, zone);
  }

  if (inner.op === 'not') {
    return canSkip(inner.predicate, zone);
  }

  const stats = zone.columns[inner.column];
  if (!stats) {
    return { skip: false, reason: `列 ${inner.column} 缺少 zone 统计，保守读取` };
  }

  switch (inner.op) {
    case 'eq': {
      // NOT (col = v)，等价于 col <> v
      if (stats.nonNullRows === 0) {
        return { skip: true, reason: '否定等值：全部为 NULL 行，NOT (col = v) 无匹配' };
      }
      if (allNonNullRowsEqual(stats, inner.value)) {
        return {
          skip: true,
          reason: `否定等值：所有非 NULL 行均等于 ${inner.value} 且无 NULL 行，NOT (col = ${inner.value}) 无匹配`,
        };
      }
      return { skip: false, reason: '否定等值：区域内可能存在不相等的行（或 NULL 行）' };
    }

    case 'ne': {
      // NOT (col <> v) 等价于 col = v
      return canSkipLeaf({ op: 'eq', column: inner.column, value: inner.value }, zone);
    }

    case 'gt': {
      // 每行都满足 col > v：min > v 且无 NULL 行
      if (comparable(stats, inner.value) && stats.min > inner.value && stats.nullCount === 0) {
        return { skip: true, reason: `最小值 ${stats.min} > ${inner.value} 且无 NULL，NOT (col > ${inner.value}) 无匹配` };
      }
      return { skip: false, reason: '否定大于：无法确认所有行都满足 col > v' };
    }

    case 'gte': {
      if (comparable(stats, inner.value) && stats.min >= inner.value && stats.nullCount === 0) {
        return { skip: true, reason: `最小值 ${stats.min} >= ${inner.value} 且无 NULL，NOT (col >= ${inner.value}) 无匹配` };
      }
      return { skip: false, reason: '否定大于等于：无法确认所有行都满足 col >= v' };
    }

    case 'lt': {
      if (comparable(stats, inner.value) && stats.max < inner.value && stats.nullCount === 0) {
        return { skip: true, reason: `最大值 ${stats.max} < ${inner.value} 且无 NULL，NOT (col < ${inner.value}) 无匹配` };
      }
      return { skip: false, reason: '否定小于：无法确认所有行都满足 col < v' };
    }

    case 'lte': {
      if (comparable(stats, inner.value) && stats.max <= inner.value && stats.nullCount === 0) {
        return { skip: true, reason: `最大值 ${stats.max} <= ${inner.value} 且无 NULL，NOT (col <= ${inner.value}) 无匹配` };
      }
      return { skip: false, reason: '否定小于等于：无法确认所有行都满足 col <= v' };
    }

    case 'between': {
      // NOT BETWEEN [low, high] 可裁剪，当且仅当每行都落在 [low, high] 内且无 NULL
      const [low, high] = inner.values ?? [];
      if (
        low != null &&
        high != null &&
        comparable(stats, low) &&
        comparable(stats, high) &&
        stats.min >= low &&
        stats.max <= high &&
        stats.nullCount === 0
      ) {
        return { skip: true, reason: `min-max [${stats.min}, ${stats.max}] 完全位于 BETWEEN [${low}, ${high}] 内且无 NULL` };
      }
      return { skip: false, reason: '否定 BETWEEN：无法确认所有行都落在区间内' };
    }

    case 'isNull': {
      // NOT (IS NULL) = IS NOT NULL：全部为 NULL 时无匹配
      if (stats.nonNullRows === 0) {
        return { skip: true, reason: `全部行为 NULL，NOT (IS NULL) 无匹配` };
      }
      return { skip: false, reason: '否定 IS NULL：存在非 NULL 行' };
    }

    case 'isNotNull': {
      // NOT (IS NOT NULL) = IS NULL：无 NULL 行时无匹配
      if (stats.nullCount === 0) {
        return { skip: true, reason: `NULL 计数为 0，NOT (IS NOT NULL) 无匹配` };
      }
      return { skip: false, reason: '否定 IS NOT NULL：存在 NULL 行' };
    }

    default:
      return { skip: false, reason: `不支持的否定谓词 ${inner.op}，保守读取` };
  }
}
