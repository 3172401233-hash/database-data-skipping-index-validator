export function makeZone({
  zoneId,
  totalRows = 100,
  pageVersion = 1,
  rowVersion,
  columns,
  pageStats,
}) {
  return {
    zoneId,
    totalRows,
    pageVersion,
    rowVersion: rowVersion ?? pageVersion,
    columns,
    ...(pageStats ? { pageStats } : {}),
  };
}

export function numericColumn({
  min,
  max,
  nullCount = 0,
  nonNullRows,
  indexVersion = 1,
  corrupted = false,
}) {
  return {
    min,
    max,
    nullCount,
    nonNullRows: nonNullRows ?? (min == null ? 0 : 100 - nullCount),
    indexVersion,
    ...(corrupted ? { corrupted: true } : {}),
  };
}

export function ids(decisions) {
  return decisions.map((decision) => decision.zoneId);
}

export function kindsFor(report, zoneId) {
  const decision = report.zoneDecisions.find((item) => item.zoneId === zoneId);
  return decision.indexEvidence.map((evidence) => evidence.kind);
}
