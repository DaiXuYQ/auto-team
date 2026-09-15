export function normalizeTeamRotationEnabled(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback !== false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'off', 'disabled', 'no'].includes(normalized)) return false;
    if (['true', '1', 'on', 'enabled', 'yes'].includes(normalized)) return true;
  }
  return Boolean(value);
}

export function teamParticipatesInRotation(team) {
  return normalizeTeamRotationEnabled(team?.rotationEnabled, true);
}

export function automaticRotationTeams(teams = [], isConfigured = () => true) {
  return (Array.isArray(teams) ? teams : []).filter((team) => (
    teamParticipatesInRotation(team) && isConfigured(team)
  ));
}
