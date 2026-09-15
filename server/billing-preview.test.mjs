import assert from 'node:assert/strict';
import test from 'node:test';
import { PROLITE_PRICE_MULTIPLIER, currencyMinorUnit, currentSeatQuantity, estimateProliteSeatCost, normalizeBillingPreview } from './billing-preview.mjs';

test('normalizes a one-seat prorated billing preview and expiry state', () => {
  const result = normalizeBillingPreview({
    current_seat_quantity: 2,
    amount_due: { amount: 1250, currency: 'usd' },
    renewal_date: '2026-09-20T00:00:00Z',
  }, {
    updatedSeats: 3,
    activeUntil: '2026-09-20T00:00:00Z',
    willRenew: true,
    billingPeriod: 'monthly',
    thresholdDays: 7,
    now: '2026-09-15T00:00:00Z',
    fetchedAt: '2026-09-15T00:00:00Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.amount, 12.5);
  assert.equal(result.currency, 'USD');
  assert.equal(result.remainingDays, 5);
  assert.equal(result.expiryStatus, 'due_soon');
  assert.equal(result.priceScope, 'incremental_prorated_default_seat');
  assert.deepEqual(result.proliteEstimate, {
    estimated: true,
    seatType: 'prolite',
    priceScope: 'estimated_incremental_prorated_prolite_seat',
    amount: 62.5,
    amountMinor: 6250,
    formattedAmount: 'US$62.50',
    currency: 'USD',
    minorUnit: 2,
    multiplier: 5,
    estimateMethod: 'default_seat_preview_multiplier',
    estimateBasis: 'live_incremental_prorated_default_seat',
  });
});

test('estimates the prorated prolite seat price from the live default preview at five times the price', () => {
  assert.equal(PROLITE_PRICE_MULTIPLIER, 5);
  assert.equal(estimateProliteSeatCost({ currency: 'USD', minorUnit: 2 }), null);
  assert.deepEqual(estimateProliteSeatCost({ amountMinor: 946, currency: 'USD', minorUnit: 2 }), {
    estimated: true,
    seatType: 'prolite',
    priceScope: 'estimated_incremental_prorated_prolite_seat',
    amount: 47.3,
    amountMinor: 4730,
    formattedAmount: 'US$47.30',
    currency: 'USD',
    minorUnit: 2,
    multiplier: 5,
    estimateMethod: 'default_seat_preview_multiplier',
    estimateBasis: 'live_incremental_prorated_default_seat',
  });
});

test('supports ISO currency minor units and epoch billing dates', () => {
  assert.equal(currencyMinorUnit('JPY'), 0);
  assert.equal(currencyMinorUnit('KWD'), 3);
  assert.equal(currencyMinorUnit('CLF'), 4);
  const result = normalizeBillingPreview({ current_seat_quantity: 9, total_amount: 800, currency: 'jpy', renewal_date: 1789862400 }, {
    updatedSeats: 10,
    activeUntil: 1789862400000,
    now: '2026-09-15T00:00:00Z',
  });
  assert.equal(result.amount, 800);
  assert.equal(result.proliteEstimate.amount, 4000);
  assert.equal(result.proliteEstimate.amountMinor, 4000);
  assert.match(result.renewalDate, /^2026-/);
});

test('rejects stale seat targets and incomplete monetary data', () => {
  assert.equal(currentSeatQuantity({ current_seat_quantity: 0 }), null);
  assert.equal(normalizeBillingPreview({ current_seat_quantity: 2, total_amount: 100, currency: 'USD' }, { updatedSeats: 4 }).message, 'billing_preview_seat_target_mismatch');
  assert.equal(normalizeBillingPreview({ current_seat_quantity: 2, currency: 'USD' }, { updatedSeats: 3 }).message, 'billing_preview_amount_missing');
});

test('classifies non-renewing and delinquent subscriptions without inventing an expiry date', () => {
  const cancelling = normalizeBillingPreview({
    currentSeatQuantity: 4,
    amount_due: { amount: 725, currency: 'EUR' },
  }, {
    updatedSeats: 5,
    activeUntil: '2026-10-15T00:00:00Z',
    willRenew: false,
    thresholdDays: 7,
    now: '2026-09-15T00:00:00Z',
  });
  assert.equal(cancelling.ok, true);
  assert.equal(cancelling.expiryStatus, 'cancelling');

  const delinquent = normalizeBillingPreview({
    current_seat_quantity: 4,
    total_amount: 725,
    currency: 'EUR',
  }, {
    updatedSeats: 5,
    activeUntil: null,
    isDelinquent: true,
    now: '2026-09-15T00:00:00Z',
  });
  assert.equal(delinquent.expiryStatus, 'delinquent');
  assert.equal(delinquent.activeUntil, null);
  assert.equal(delinquent.remainingDays, null);
});
