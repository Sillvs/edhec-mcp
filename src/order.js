// Snack-corner pre-orders (MONEWEB Click & Collect, "C&C EDHEC : Le Break"). Beta.
//
// Ordering spends money, so it always takes two steps:
//   1. prepare(): checks the ordering window and stock, builds an UNPAID draft cart and returns the exact
//      summary (items, total, balance afterwards) plus a single-use confirmationId (10 minutes).
//   2. confirm(): only after the user said yes to that summary. Re-reads the cart, refuses if anything
//      changed, then books it (validate) and pays it from the campus card (payment-account-process).
// Paid orders cannot be cancelled. Unpaid drafts expire on their own.
import crypto from 'node:crypto';
import { withBrowser } from './browser.js';
import { MW, ensureMoneweb } from './resto.js';

export const SERVICE_ID = 202;          // C&C EDHEC : Le Break
export const MAX_TOTAL_EUR = 10;        // hard cap for one order, whatever the summary says
const TTL_MS = 10 * 60 * 1000;
const API = '/client/api/reservation';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Find one product by id or name among the candidates of one formula component.
export function matchProduct(query, candidates) {
  const q = String(query).trim();
  if (/^\d{1,7}$/.test(q)) {
    const hit = candidates.find(p => String(p.id) === q);
    if (hit) return hit;
  }
  const nq = norm(q);
  if (!nq) throw new Error('Empty product name');
  const exact = candidates.filter(p => norm(p.name) === nq);
  if (exact.length === 1) return exact[0];
  const words = nq.split(' ');
  const partial = candidates.filter(p => { const n = norm(p.name); return words.every(w => n.includes(w)); });
  if (partial.length === 1) return partial[0];
  const list = candidates.map(p => p.name).join(', ');
  if (!partial.length) throw new Error(`"${q}" is not on today's list for this part of the formula. Available: ${list}`);
  throw new Error(`"${q}" matches several products (${partial.map(p => p.name).join(', ')}). Be more specific.`);
}

// The key MONEWEB expects on validate: a-la-carte lines, then formula lines, each sorted by Id.
export function uniqueKey(reservation) {
  const byId = (a, b) => a.Id - b.Id;
  const pl = [...(reservation.ProductLines || [])].sort(byId).map(l => `${l.Id}-${l.Product.Id}-${l.Quantity}`);
  const ml = [...(reservation.MenuMealLines || [])].sort(byId).map(l =>
    `${l.Id}-${l.MenuMeal.Id}-${l.Quantity}(${[...l.ProductLines].sort((a, b) => a.Order - b.Order).map(p => `${p.Id}-${p.Product.Id}`).join('/')})`);
  return [...pl, ...ml].join('/');
}

export function parisClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// ---------------------------------------------------------------------------
// Confirmations (single use, 10 minutes)
// ---------------------------------------------------------------------------
const pending = new Map(); // confirmationId -> { cartId, key, total, items, expires, used }

export function remember(entry, now = Date.now()) {
  for (const [k, v] of pending) if (v.expires < now || v.used) pending.delete(k);
  const id = crypto.randomUUID();
  pending.set(id, { ...entry, expires: now + TTL_MS, used: false });
  return id;
}

export function claimConfirmation(id, expectedTotalEUR, { now = Date.now() } = {}) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Unknown confirmationId');
  const p = pending.get(id);
  if (!p) throw new Error('Unknown confirmationId. Call resto_order_prepare again.');
  if (p.used) throw new Error('This order confirmation was already used. Prepare a new order if the user really wants another one.');
  if (now > p.expires) { pending.delete(id); throw new Error('This order confirmation expired (10 minutes). Prepare the order again and show the user the new summary.'); }
  if (typeof expectedTotalEUR !== 'number' || !Number.isFinite(expectedTotalEUR) || Math.abs(expectedTotalEUR - p.total) > 0.001) {
    throw new Error(`expectedTotalEUR must be the total the user confirmed (${p.total.toFixed(2)} EUR).`);
  }
  p.used = true; // one attempt only, even if booking fails later
  return p;
}

// ---------------------------------------------------------------------------
// MONEWEB calls
// ---------------------------------------------------------------------------
async function call(c, method, p, data) {
  if (!p.startsWith(API)) throw new Error('internal: unexpected path');
  const r = await c.request.fetch(MW + p, {
    method, data, headers: { 'X-Requested-With': 'XMLHttpRequest' }, failOnStatusCode: false, maxRedirects: 0, timeout: 60000,
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* empty body */ }
  if (r.status() >= 400) {
    const msg = Array.isArray(body) ? body[0]?.Message : body?.Message;
    throw new Error(`MONEWEB refused ${method} ${p.replace(/\d{4,}/g, '…')} (HTTP ${r.status()})${msg ? `: ${String(msg).slice(0, 200)}` : ''}`);
  }
  return body;
}

// Ordering window: the service must be bookable now and we must be before its time limit (Paris time).
async function serviceWindow(c, now) {
  const list = await call(c, 'GET', `${API}-service/en-GB`);
  const svc = (list || []).find(s => s.Id === SERVICE_ID);
  if (!svc || !svc.CanCreate) throw new Error('Snack-corner ordering is closed right now. It opens in the morning, same day only, until about 10:00.');
  const detail = await call(c, 'GET', `${API}-service/${SERVICE_ID}/en-GB`);
  const limit = String(detail?.Parameters?.ReservationTimeLimit || '10:00:00').slice(0, 5);
  const { time } = parisClock(now);
  if (time >= limit) throw new Error(`Too late: snack-corner orders close at ${limit} (Paris time). It is ${time}.`);
  return { name: svc.Name, orderUntil: limit, description: String(detail?.Description || svc.Description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) };
}

function formulaFromOffer(offer) {
  const meals = offer?.MenuMeals || [];
  if (meals.length !== 1) throw new Error(`Expected one snack-corner formula, found ${meals.length}. Order on https://allresto.moneweb.fr instead.`);
  const meal = meals[0];
  const rem = offer.ProductsRemainingQuantity || {};
  const comps = [...meal.Components].sort((a, b) => a.Order - b.Order);
  const parts = comps.map(comp => {
    const seen = new Set();
    const products = meal.Products.filter(p => p.Component === comp.Id && !seen.has(p.Id) && seen.add(p.Id))
      .map(p => ({ id: p.Id, name: String(p.Name).replace(/\s+/g, ' ').trim(), extraEUR: p.Amount?.ExtraCost || 0, left: Object.hasOwn(rem, p.Id) ? rem[p.Id] : null }))
      .filter(p => p.left !== 0);
    return { componentId: comp.Id, name: comp.Name, order: comp.Order, required: comp.Required, products };
  });
  return { meal: { id: meal.Id, name: meal.Name, description: meal.Description, priceEUR: meal.Amount?.VATInc }, parts };
}

// ---------------------------------------------------------------------------
// Read-only: today's snack-corner offer
// ---------------------------------------------------------------------------
export function offer({ now = new Date() } = {}) {
  return withBrowser(async (c) => {
    await ensureMoneweb(c);
    const window = await serviceWindow(c, now);
    // The offer endpoint needs a cart id; any of your own past snack-corner orders works and stays untouched.
    // Older orders sometimes return an empty offer, so try the most recent ones first.
    const own = await call(c, 'GET', `${API}?Validated=-1`);
    const past = (own || []).filter(r => r.Service?.Id === SERVICE_ID && Number.isInteger(r.Id))
      .sort((a, b) => String(b.DeliveryDateTime).localeCompare(String(a.DeliveryDateTime))).slice(0, 6);
    let raw = null;
    for (const r of past) {
      const o = await call(c, 'GET', `${API}/${r.Id}/offer/en-GB`);
      if (o?.MenuMeals?.length) { raw = o; break; }
    }
    if (!raw) return { ...window, note: 'Could not read today\'s offer without creating a cart. Use resto_order_prepare: it lists what is available when an item is missing.' };
    const f = formulaFromOffer(raw);
    return { ...window, ...f, howToOrder: `Pick one product per part (${f.parts.map(p => p.name).join(' + ')}), then call resto_order_prepare.` };
  });
}

// ---------------------------------------------------------------------------
// Step 1: prepare (unpaid draft cart + exact summary)
// ---------------------------------------------------------------------------
export function prepare({ main, sides, now = new Date() } = {}) {
  const str = (v, what) => {
    if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`${what} must be a product name or id`);
    const s = String(v).trim();
    if (!s || s.length > 80) throw new Error(`${what} must be 1-80 characters`);
    return s;
  };
  if (!Array.isArray(sides) || sides.length < 1 || sides.length > 4) throw new Error('sides must be a list of 1-4 product names');
  const wanted = [str(main, 'main'), ...sides.map((s, i) => str(s, `sides[${i}]`))];

  return withBrowser(async (c) => {
    await ensureMoneweb(c);
    const window = await serviceWindow(c, now);

    const draft = await call(c, 'POST', `${API}/en-GB`);
    const R = `${API}/${Number(draft?.Id)}`;
    if (!Number.isInteger(draft?.Id)) throw new Error('MONEWEB did not create a cart');
    await call(c, 'PUT', `${R}/service`, { service: SERVICE_ID });
    let res = await call(c, 'GET', R);
    const today = parisClock(now).date;
    if (!res.DeliveryLocation || !String(res.DeliveryDateTime || '').startsWith(today)) {
      throw new Error('MONEWEB did not set today\'s pickup for the snack corner. Nothing was ordered.');
    }

    const f = formulaFromOffer(await call(c, 'GET', `${R}/offer/en-GB`));
    if (wanted.length !== f.parts.length) {
      throw new Error(`The formula needs exactly ${f.parts.length} items: ${f.parts.map(p => p.name).join(' + ')} (main + ${f.parts.length - 1} sides). Nothing was ordered.`);
    }
    const picks = f.parts.map((part, i) => ({ part, product: matchProduct(wanted[i], part.products) }));

    const line = await call(c, 'POST', `${R}/menu`, { id: f.meal.id, quantity: 1 });
    for (const { part, product } of picks) {
      await call(c, 'POST', `${R}/menu/${Number(line.Id)}/product`, { id: product.id, component: part.componentId, order: part.order });
    }

    res = await call(c, 'GET', R);
    const lines = res.MenuMealLines || [];
    const got = lines.flatMap(l => l.ProductLines.map(p => p.Product.Id)).sort((a, b) => a - b).join(',');
    const want = picks.map(p => p.product.id).sort((a, b) => a - b).join(',');
    if ((res.ProductLines || []).length || lines.length !== 1 || got !== want) throw new Error('The cart does not contain exactly the requested items. Nothing was ordered.');

    const rd = await call(c, 'GET', `${R}/receipt-details`);
    const total = Number(rd?.TotalDu);
    if (!Number.isFinite(total) || total < 0) throw new Error('MONEWEB returned no total. Nothing was ordered.');
    if (total > MAX_TOTAL_EUR) throw new Error(`Total ${total.toFixed(2)} EUR is above this server's limit of ${MAX_TOTAL_EUR} EUR. Nothing was ordered.`);
    if (rd.IsLimiteSoldeError || !rd.CanProcessByAccount || Number(rd.NouveauSolde) < 0) {
      throw new Error(`MONEWEB says this order cannot be paid from your card right now${rd.CannotProcessByAccountReason ? ` (${String(rd.CannotProcessByAccountReason).slice(0, 200)})` : ''}. Top up at https://allresto.moneweb.fr yourself if needed. Nothing was ordered.`);
    }

    const items = picks.map(p => ({ part: p.part.name, product: p.product.name, ...(p.product.left != null ? { left: p.product.left } : {}) }));
    const warnings = [];
    if (!(rd.ComposantsTarifaires || []).length && f.meal.priceEUR && total >= f.meal.priceEUR) {
      warnings.push(`No student discount on this order: it costs the full ${total.toFixed(2)} EUR. The 1 EUR formula is once per card and service, so you have probably used it today already.`);
    }
    const confirmationId = remember({ cartId: draft.Id, key: uniqueKey(res), total, items });
    return {
      summary: {
        service: window.name,
        formula: `${f.meal.name} (${f.meal.priceEUR?.toFixed?.(2) ?? f.meal.priceEUR} EUR)`,
        items,
        discounts: (rd.ComposantsTarifaires || []).map(x => `${x.Libelle}: -${Number(x.Montant).toFixed(2)} EUR`),
        totalEUR: total,
        balanceBeforeEUR: rd.AncienSolde,
        balanceAfterEUR: rd.NouveauSolde,
        pickup: res.DeliveryLocation?.Name || null,
        pickupInfo: window.description || null,
        orderUntil: `${window.orderUntil} (Paris time)`,
      },
      ...(warnings.length ? { warnings } : {}),
      confirmationId,
      expiresInMinutes: TTL_MS / 60000,
      nextStep: 'Nothing is booked or paid yet. Show this summary to the user. Only if they say yes to exactly these items and this total, call resto_order_confirm with this confirmationId and expectedTotalEUR. Paid orders cannot be cancelled and are not refunded if not collected.',
    };
  });
}

// ---------------------------------------------------------------------------
// Step 2: confirm (book + pay exactly the prepared cart, once)
// ---------------------------------------------------------------------------
export function confirm({ confirmationId, expectedTotalEUR, now = new Date() } = {}) {
  const p = claimConfirmation(confirmationId, expectedTotalEUR);
  return withBrowser(async (c) => {
    await ensureMoneweb(c);
    await serviceWindow(c, now);
    const R = `${API}/${Number(p.cartId)}`;
    const res = await call(c, 'GET', R);
    if (res?.State?.Id !== 'EnCours') throw new Error(`The cart is no longer open (${res?.State?.Label || 'unknown state'}). Prepare the order again.`);
    if (uniqueKey(res) !== p.key) throw new Error('The cart changed since the summary. Nothing was ordered. Prepare the order again.');
    const rd = await call(c, 'GET', `${R}/receipt-details`);
    if (Math.abs(Number(rd?.TotalDu) - p.total) > 0.001) throw new Error(`The total changed (${rd?.TotalDu} EUR instead of ${p.total.toFixed(2)} EUR). Nothing was ordered. Prepare the order again.`);
    if (rd.IsLimiteSoldeError || !rd.CanProcessByAccount) throw new Error('MONEWEB says the card cannot pay this right now. Nothing was ordered.');

    await call(c, 'PUT', `${R}/validate`, { uniqueKey: p.key, amountPayment: p.total, paymentByTransaction: false, PaymentByAccount: true });
    let after = await call(c, 'GET', R);
    if (after?.PaymentState?.Id !== 'Paye') {
      await call(c, 'POST', `${R}/payment-account-process`);
      after = await call(c, 'GET', R);
    }
    const paid = after?.PaymentState?.Id === 'Paye';
    const booked = after?.State?.Id === 'Confirme';
    if (!paid || !booked) {
      throw new Error(`The order was sent but MONEWEB shows "${after?.State?.Label}" / "${after?.PaymentState?.Label}". Check https://allresto.moneweb.fr (reference ${after?.Reference}) before trying again.`);
    }
    return {
      ordered: true,
      reference: after.Reference,
      state: after.State.Label,
      payment: after.PaymentState.Label,
      items: p.items.map(i => i.product),
      paidEUR: p.total,
      balanceAfterEUR: rd.NouveauSolde,
      pickup: after.DeliveryLocation?.Name || null,
      cancellable: !!after.Cancellable,
      reminder: 'Bring your student card to pick it up. Orders that are not collected are not refunded.',
    };
  });
}
