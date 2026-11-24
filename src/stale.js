// 索引（zone map）与数据页一致性检查。
//
// 触发“必须读取 + 过期证据”的情形：
//   1. 谓词引用列的统计缺失；
//   2. 统计被显式标记为损坏（corrupted）；
//   3. 统计内部不自洽（min > max、计数之和不等于总行数）；
//   4. zone map 版本落后于数据页版本 / 行版本（更新只改了数据页，未同步索引）；
//   5. 更新日志显示谓词列在该区域被更新过，但索引版本停留在更新之前。

function normalizeChangeLog(changeLog) {
  return new Map((changeLog ?? []).map((entry) => [entry.zoneId, entry]));
}

function validateStats(column, stats, totalRows) {
  const issues = [];
  if (stats.corrupted === true) {
    issues.push('统计被标记为损坏 (corrupted=true)');
  }
  if (stats.min == null || stats.max == null) {
    if (stats.nonNullRows > 0) {
      issues.push('存在非 NULL 行但 min/max 缺失');
    }
  } else if (typeof stats.min !== typeof stats.max) {
    issues.push('min/max 类型不一致');
  } else if (stats.min > stats.max) {
    issues.push(`min-max 倒置 (min=${stats.min}, max=${stats.max})`);
  }
  const counted = (stats.nullCount ?? 0) + (stats.nonNullRows ?? 0);
  if (counted !== totalRows) {
    issues.push(`NULL/非NULL 计数之和 (${counted}) 不等于区域总行数 (${totalRows})`);
  }
  if (stats.nullCount < 0 || stats.nonNullRows < 0) {
    issues.push('NULL/非NULL 计数出现负数');
  }
  return issues;
}

// 返回该 zone 针对给定谓词列的全部不可裁剪证据；空数组表示索引可信
export function collectIndexEvidence(zone, predicateColumns, changeLog) {
  const logByZone = changeLog instanceof Map ? changeLog : normalizeChangeLog(changeLog);
  const evidence = [];

  for (const column of predicateColumns) {
    const stats = zone.columns[column];

    if (!stats) {
      evidence.push({
        kind: 'missing_stats',
        zoneId: zone.zoneId,
        column,
        detail: `区域 ${zone.zoneId} 缺少列 ${column} 的 zone map 统计`,
      });
      continue;
    }

    for (const issue of validateStats(column, stats, zone.totalRows)) {
      evidence.push({
        kind: 'corrupt_stats',
        zoneId: zone.zoneId,
        column,
        detail: `区域 ${zone.zoneId} 列 ${column}：${issue}`,
      });
    }

    const indexVersion = stats.indexVersion ?? zone.zoneMapVersion;
    const pageVersion = zone.pageVersion;
    const rowVersion = zone.rowVersion ?? pageVersion;

    if (indexVersion < pageVersion || indexVersion < rowVersion) {
      evidence.push({
        kind: 'stale_version',
        zoneId: zone.zoneId,
        column,
        indexVersion,
        pageVersion,
        rowVersion,
        detail:
          `区域 ${zone.zoneId} 列 ${column} 的索引版本 v${indexVersion} 落后于 ` +
          `数据页 v${pageVersion} / 行版本 v${rowVersion}，更新后未同步 zone map`,
      });
    }

    const logEntry = logByZone.get(zone.zoneId);
    if (logEntry) {
      const touchedColumns = logEntry.columns ?? [];
      if (touchedColumns.includes(column) && indexVersion < (logEntry.pageVersionAfter ?? pageVersion)) {
        evidence.push({
          kind: 'changelog_mismatch',
          zoneId: zone.zoneId,
          column,
          changeLog: logEntry,
          detail:
            `更新日志显示区域 ${zone.zoneId} 的列 ${column} 在 v${logEntry.pageVersionBefore} -> ` +
            `v${logEntry.pageVersionAfter} 被更新（${logEntry.operation ?? 'UPDATE'}），` +
            `但索引停留在 v${indexVersion}`,
        });
      }
    }

    // 若同时提供了数据页的真实边界（pageStats），与 zone map 边界对账，
    // 直接暴露“边界已变但索引仍是旧值”的事实。
    if (zone.pageStats && zone.pageStats[column]) {
      const actual = zone.pageStats[column];
      if (
        actual.min != null &&
        actual.max != null &&
        stats.min != null &&
        stats.max != null &&
        (actual.min !== stats.min || actual.max !== stats.max)
      ) {
        evidence.push({
          kind: 'boundary_drift',
          zoneId: zone.zoneId,
          column,
          indexedMinMax: [stats.min, stats.max],
          actualMinMax: [actual.min, actual.max],
          detail:
            `区域 ${zone.zoneId} 列 ${column} 的索引边界 [${stats.min}, ${stats.max}] ` +
            `与数据页真实边界 [${actual.min}, ${actual.max}] 不一致`,
        });
      }
    }
  }

  return evidence;
}
