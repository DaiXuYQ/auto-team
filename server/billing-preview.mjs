const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
]);

const FOUR_DECIMAL_CURRENCIES = new Set(['CLF', 'UYW']);

export function currencyMinorUnit(currency) {
  const normalized = String(currency || '').trim().toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(normalized)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(normalized)) return 3;
  if (FOUR_DECIMAL_CURRENCIES.has(normalized)) return 4;
  return 2;
}

function formattedCurrencyAmount(amount, currency, minorUnit = currencyMinorUnit(currency)) {
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency,
      minimumFractionDigits: minorUnit,
      maximumFractionDigits: minorUnit,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(minorUnit)}`;
  }
}

export const PROLITE_PRICE_MULTIPLIER = 5;

export function estimateProliteSeatCost(defaultAmount = {}) {
  const rawAmountMinor = defaultAmount.amountMinor;
  if (rawAmountMinor === undefined || rawAmountMinor === null || rawAmountMinor === '') return null;
  const amountMinor = Number(rawAmountMinor) * PROLITE_PRICE_MULTIPLIER;
  const currency = String(defaultAmount.currency || '').trim().toUpperCase();
  const minorUnit = Number(defaultAmount.minorUnit);
  if (!Number.isFinite(amountMinor) || !Number.isInteger(amountMinor) || !/^[A-Z]{3}$/.test(currency) || !Number.isInteger(minorUnit)) return null;
  const amount = amountMinor / (10 ** minorUnit);
  return {
    estimated: true,
    seatType: 'prolite',
    priceScope: 'estimated_incremental_prorated_prolite_seat',
    amount,
    amountMinor,
    formattedAmount: formattedCurrencyAmount(amount, currency, minorUnit),
    currency,
    minorUnit,
    multiplier: PROLITE_PRICE_MULTIPLIER,
    estimateMethod: 'default_seat_preview_multiplier',
    estimateBasis: 'live_incremental_prorated_default_seat',
  };
}

export function currentSeatQuantity(payload = {}) {
  const value = Number(payload?.current_seat_quantity ?? payload?.currentSeatQuantity);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function normalizedDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = typeof value === 'number' || /^\d+$/.test(String(value).trim()) ? Number(value) : null;
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function amountDetails(payload = {}) {
  const amountDue = payload?.amount_due && typeof payload.amount_due === 'object' ? payload.amount_due : {};
  const amountMinor = Number(amountDue.amount ?? payload?.total_amount ?? payload?.totalAmount);
  const currency = String(payload?.currency || amountDue.currency || '').trim().toUpperCase();
  if (!Number.isFinite(amountMinor)) return { ok: false, message: 'billing_preview_amount_missing' };
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, message: 'billing_preview_currency_missing' };
  const minorUnit = currencyMinorUnit(currency);
  const amount = amountMinor / (10 ** minorUnit);
  const formattedAmount = formattedCurrencyAmount(amount, currency, minorUnit);
  return { ok: true, amountMinor, amount, currency, minorUnit, formattedAmount };
}

export function normalizeBillingPreview(payload = {}, options = {}) {
  const currentSeats = currentSeatQuantity(payload);
  if (currentSeats == null) return { ok: false, message: 'billing_preview_current_seats_missing' };
  const updatedSeats = Number(options.updatedSeats);
  if (!Number.isInteger(updatedSeats) || updatedSeats !== currentSeats + 1) {
    return { ok: false, message: 'billing_preview_seat_target_mismatch', currentSeats, expectedUpdatedSeats: currentSeats + 1 };
  }
  const amount = amountDetails(payload);
  if (!amount.ok) return amount;
  const proliteEstimate = estimateProliteSeatCost(amount);

  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const activeUntil = normalizedDate(options.activeUntil);
  const renewalDate = normalizedDate(payload?.renewal_date ?? payload?.renewalDate);
  const thresholdDays = Math.min(365, Math.max(1, Number(options.thresholdDays) || 7));
  const referenceTime = Date.parse(options.now || fetchedAt);
  const expiryTime = Date.parse(activeUntil || '');
  const remainingSeconds = Number.isFinite(referenceTime) && Number.isFinite(expiryTime)
    ? Math.ceil((expiryTime - referenceTime) / 1000)
    : null;
  const remainingDays = remainingSeconds == null ? null : Math.ceil(remainingSeconds / 86400);
  const isDelinquent = options.isDelinquent === true;
  const willRenew = typeof options.willRenew === 'boolean' ? options.willRenew : null;
  const expiryStatus = isDelinquent
    ? 'delinquent'
    : remainingSeconds != null && remainingSeconds <= 0
      ? 'expired'
      : remainingDays != null && remainingDays <= thresholdDays
        ? 'due_soon'
        : willRenew === false
          ? 'cancelling'
          : activeUntil
            ? 'active'
            : 'unknown';

  return {
    ok: true,
    currentSeats,
    updatedSeats,
    seatType: 'default',
    priceScope: 'incremental_prorated_default_seat',
    ...amount,
    proliteEstimate,
    activeUntil,
    renewalDate,
    willRenew,
    isDelinquent,
    billingPeriod: options.billingPeriod || null,
    remainingSeconds,
    remainingDays,
    thresholdDays,
    expiryStatus,
    fetchedAt,
  };
}
