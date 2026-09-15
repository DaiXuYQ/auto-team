export function managerLoginCooldown(lastAttemptAt, cooldownMs = 900_000, currentTime = Date.now()) {
  const attemptedAt = Date.parse(lastAttemptAt || '');
  if (!Number.isFinite(attemptedAt)) return 0;
  return Math.max(0, cooldownMs - (currentTime - attemptedAt));
}
