export function selectTeamSub2ApiRecords(records = [], mother = null, excludeMother = false) {
  if (!excludeMother) return records;
  const email = String(mother?.email || '').trim().toLowerCase();
  return email ? records.filter((record) => String(record?.email || '').trim().toLowerCase() !== email) : records;
}
