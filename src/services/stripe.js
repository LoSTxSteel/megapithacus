/**
 * Stripe REST helpers for the receiving account.
 * Lists succeeded PaymentIntents (covers Checkout / Payment Links).
 */

const API = 'https://api.stripe.com/v1';

async function stripeGet(path, secretKey, params = {}) {
  if (!secretKey || !/^sk_(test_|live_)/.test(secretKey)) {
    throw new Error(
      'Enter a valid Stripe secret key starting with sk_test_ or sk_live_.'
    );
  }

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [sub, subVal] of Object.entries(value)) {
        qs.set(`${key}[${sub}]`, String(subVal));
      }
    } else {
      qs.set(key, String(value));
    }
  }

  const url = `${API}${path}${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Stripe-Version': '2024-06-20',
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail =
      body?.error?.message || body?.error?.type || res.statusText || 'request failed';
    throw new Error(`Stripe API failed: ${detail}`);
  }
  return body;
}

async function testStripeConnection(secretKey) {
  // Lightweight account ping
  await stripeGet('/balance', secretKey);
  return { ok: true };
}

/**
 * List succeeded payment intents created since `createdGte` (unix seconds).
 */
async function listSucceededPayments({ secretKey, createdGte }) {
  const payments = [];
  let startingAfter = null;
  let pages = 0;

  while (pages < 10) {
    pages += 1;
    const params = {
      limit: 100,
      created: createdGte ? { gte: Math.floor(createdGte) } : undefined,
    };
    if (startingAfter) params.starting_after = startingAfter;

    const body = await stripeGet('/payment_intents', secretKey, params);
    const data = body.data || [];

    for (const pi of data) {
      if (pi.status !== 'succeeded') continue;
      const amountReceived =
        typeof pi.amount_received === 'number' ? pi.amount_received : pi.amount;
      if (!Number.isFinite(amountReceived) || amountReceived <= 0) continue;

      const meta = pi.metadata || {};
      payments.push({
        paymentIntentId: pi.id,
        amount: amountReceived / 100,
        currency: (pi.currency || '').toUpperCase() || null,
        createdAt: pi.created
          ? new Date(pi.created * 1000).toISOString()
          : new Date().toISOString(),
        description: pi.description || null,
        receiptEmail: pi.receipt_email || null,
        customerId:
          typeof pi.customer === 'string' ? pi.customer : pi.customer?.id || null,
        metadata: meta,
        note:
          meta.note ||
          meta.message ||
          meta.discord ||
          pi.description ||
          null,
      });
    }

    if (!body.has_more || !data.length) break;
    startingAfter = data[data.length - 1].id;
  }

  return payments;
}

module.exports = {
  testStripeConnection,
  listSucceededPayments,
};
