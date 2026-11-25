'use strict';
var V = require('http'),
  P = require('crypto'),
  { URL: K } = require('url'),
  c = {
    port: Number(process.env.PORT || 8080),
    chaos: process.env.SIM_CHAOS || 'default',
    scale: Math.max(0.01, Number(process.env.SIM_TIME_SCALE || 1)),
    payoutWebhook: process.env.PAYOUT_WEBHOOK_URL || '',
    secret: process.env.WEBHOOK_SECRET || 'hamtapay-sim-secret',
    adminKey: process.env.SIM_ADMIN_KEY || '',
    publicBase:
      process.env.SIM_PUBLIC_URL ||
      `http://localhost:${process.env.PORT || 8080}`,
    seed: Number(process.env.SIM_SEED || Date.now() % 2147483647),
  },
  D = c.seed >>> 0;
function _() {
  ((D |= 0), (D = (D + 1831565813) | 0));
  let t = Math.imul(D ^ (D >>> 15), 1 | D);
  return (
    (t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t),
    ((t ^ (t >>> 14)) >>> 0) / 4294967296
  );
}
var p = (t, e) => t + _() * (e - t),
  m = (t, e) => setTimeout(e, (t * 1e3) / c.scale),
  U = (t) => t + P.randomBytes(8).toString('hex'),
  g = () => new Date().toISOString(),
  w = {
    off: {
      dupCb: 0,
      missCb: 0,
      orderCb: 0,
      forgeCb: 0,
      verify503: 0,
      timeout: 0,
      e503: 0,
      dupWh: 0,
      staleWh: 0,
      forgeWh: 0,
      missWh: 0,
      returned: 0,
      slow: 0,
    },
    default: {
      dupCb: 0.3,
      missCb: 0.1,
      orderCb: 0.1,
      forgeCb: 0.05,
      verify503: 0.05,
      timeout: 0.1,
      e503: 0.1,
      dupWh: 0.3,
      staleWh: 0.1,
      forgeWh: 0.05,
      missWh: 0.1,
      returned: 0.05,
      slow: 0.1,
    },
    hostile: {
      dupCb: 0.6,
      missCb: 0.2,
      orderCb: 0.2,
      forgeCb: 0.1,
      verify503: 0.1,
      timeout: 0.25,
      e503: 0.2,
      dupWh: 0.5,
      staleWh: 0.2,
      forgeWh: 0.1,
      missWh: 0.2,
      returned: 0.1,
      slow: 0.2,
    },
  },
  B = (t) => (w[c.chaos] || w.default)[t],
  A = { payment: [], payout: [] };
function $(t) {
  return A[t].shift() || null;
}
function h(t, e, a) {
  return e ? e.includes(a) : _() < B(a);
}
function r(t, e, a, i = {}) {
  let s = typeof a == 'string' ? a : JSON.stringify(a);
  (t.writeHead(e, {
    'content-type':
      typeof a == 'string'
        ? 'text/csv; charset=utf-8'
        : 'application/json; charset=utf-8',
    ...i,
  }),
    t.end(s));
}
function j(t) {
  return new Promise((e) => {
    let a = '';
    (t.on('data', (i) => (a += i)),
      t.on('end', () => {
        try {
          e(a ? JSON.parse(a) : {});
        } catch {
          e({ __invalid: !0 });
        }
      }));
  });
}
async function G(t, e, a = {}) {
  let i = JSON.stringify(e);
  try {
    return (
      await fetch(t, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...a },
        body: i,
        signal: AbortSignal.timeout(1e4),
      })
    ).status;
  } catch {
    return 0;
  }
}
var J = (t) => P.createHmac('sha256', c.secret).update(t).digest('hex');
function Y(t) {
  if (typeof t != 'string') return !1;
  let e = t.replace(/\s+/g, '').toUpperCase();
  if (!/^IR\d{24}$/.test(e)) return !1;
  let i = (e.slice(4) + e.slice(0, 4)).replace(/[A-Z]/g, (n) =>
      String(n.charCodeAt(0) - 55),
    ),
    s = 0;
  for (let n of i) s = (s * 10 + Number(n)) % 97;
  return s === 1;
}
var H = (t) => typeof t == 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(t),
  F = (t) =>
    (typeof t == 'number' && Number.isInteger(t) && t > 0) ||
    (typeof t == 'string' && /^\d+$/.test(t) && t !== '0'),
  Z = (t) =>
    typeof t == 'string' && /^\d+(\.\d{1,6})?$/.test(t) && Number(t) > 0,
  S = new Map();
function b(t, e, a = {}) {
  return G(t.callbackUrl, {
    token: t.token,
    orderId: t.orderId,
    status: e,
    ...a,
  });
}
function z(t) {
  let e = t.scen,
    a = t.status === 'PAID',
    i = a ? 'OK' : 'NOK';
  if (h('payment', e, 'missCb')) {
    t.events.push('callback-missing');
    return;
  }
  let s = p(0.2, 2);
  if (
    (a && h('payment', e, 'orderCb')
      ? (t.events.push('callback-nok-first'),
        m(s, () => b(t, 'NOK')),
        m(s + 1.5, () => b(t, 'OK')))
      : m(s, () => b(t, i)),
    h('payment', e, 'dupCb'))
  ) {
    let n = 1 + Math.floor(p(1, 3));
    t.events.push(`callback-dup-x${n}`);
    for (let o = 0; o < n; o++) m(s + (o === 0 ? 0 : p(0, 3)), () => b(t, i));
  }
  a &&
    h('payment', e, 'forgeCb') &&
    (t.events.push('callback-forged'),
    m(s + 0.5, () => b(t, 'OK', { amount: String(BigInt(t.amount) * 10n) })));
}
function W(t) {
  t.status === 'PAID' &&
    Date.now() - t.paidAt > (600 * 1e3) / c.scale &&
    ((t.status = 'REVERSED'),
    (t.reversedAt = g()),
    t.events.push('auto-reversed-not-verified'));
}
async function Q(t, e, a, i) {
  let s = a.pathname.split('/').filter(Boolean);
  if (t.method === 'POST' && s[1] === 'payments' && s.length === 2) {
    let { amount: n, callbackUrl: o, orderId: d } = i;
    if (!F(n))
      return r(e, 400, {
        code: -11,
        message: 'amount must be a positive integer',
      });
    if (BigInt(n) < 10000n)
      return r(e, 400, { code: -12, message: 'amount below minimum' });
    if (typeof o != 'string' || !/^https?:\/\//.test(o))
      return r(e, 400, { code: -13, message: 'callbackUrl is required' });
    let f = U('A0'),
      u = {
        token: f,
        amount: String(n),
        callbackUrl: o,
        orderId: d ?? null,
        status: 'INIT',
        createdAt: g(),
        events: [],
        scen: $('payment'),
      };
    return (
      S.set(f, u),
      r(e, 201, {
        code: 100,
        token: f,
        paymentUrl: `${c.publicBase}/psp/pay/${f}`,
      })
    );
  }
  if (s[1] === 'pay' && s[2]) {
    let n = S.get(s[2]);
    if (!n) return r(e, 404, { code: -9, message: 'unknown token' });
    if (t.method === 'GET') {
      let o = (BigInt(n.amount) / 10n).toLocaleString('fa-IR');
      return r(e, 200, {
        token: n.token,
        merchant: 'Hamta Exchange (sandbox)',
        amount: n.amount,
        display: `\u0645\u0628\u0644\u063A \u0642\u0627\u0628\u0644 \u067E\u0631\u062F\u0627\u062E\u062A: ${o} \u062A\u0648\u0645\u0627\u0646`,
        status: n.status,
      });
    }
    if (t.method === 'POST')
      return n.status !== 'INIT'
        ? r(e, 409, { code: -10, message: 'already processed' })
        : ((n.status = i.result === 'fail' ? 'FAILED' : 'PAID'),
          n.status === 'PAID' &&
            ((n.paidAt = Date.now()),
            (n.refId = String(Math.floor(p(1e9, 9e9))))),
          z(n),
          r(e, 200, { code: 100, status: n.status }));
  }
  if (t.method === 'POST' && s[1] === 'verify') {
    let n = S.get(i.token);
    return n
      ? h('payment', n.scen, 'verify503') && !n.verify503Done
        ? ((n.verify503Done = !0),
          r(e, 503, { code: -1, message: 'service unavailable' }))
        : (W(n),
          n.status === 'VERIFIED'
            ? r(e, 200, {
                code: 101,
                status: 'ALREADY_VERIFIED',
                amount: n.amount,
                refId: n.refId,
              })
            : n.status === 'PAID'
              ? ((n.status = 'VERIFIED'),
                (n.verifiedAt = g()),
                r(e, 200, {
                  code: 100,
                  status: 'OK',
                  amount: n.amount,
                  refId: n.refId,
                }))
              : n.status === 'REVERSED'
                ? r(e, 200, {
                    code: -54,
                    status: 'EXPIRED',
                    message:
                      'payment was not verified in time and has been reversed',
                  })
                : r(e, 200, {
                    code: -51,
                    status: 'FAILED',
                    message: 'payment not successful',
                  }))
      : r(e, 404, { code: -9, message: 'unknown token' });
  }
  if (t.method === 'GET' && s[1] === 'payments' && s[2]) {
    let n = S.get(s[2]);
    return n
      ? (W(n),
        r(e, 200, {
          token: n.token,
          orderId: n.orderId,
          status: n.status,
          amount: n.amount,
          refId: n.refId ?? null,
        }))
      : r(e, 404, { code: -9, message: 'unknown token' });
  }
  return t.method === 'GET' && s[1] === 'settlement'
    ? r(e, 200, nt(a.searchParams.get('date')))
    : r(e, 404, { code: -404, message: 'not found' });
}
var N = new Map();
function C(t) {
  return {
    requestId: t.requestId,
    trackingId: t.trackingId,
    status: t.status,
    reason: t.reason ?? null,
    amount: t.amount,
    currency: t.currency,
    destination: t.destination,
    updatedAt: t.updatedAt,
  };
}
async function v(t, e, { forged: a = !1, occurredAt: i } = {}) {
  if (!c.payoutWebhook) return;
  let s = {
      event: 'transfer.updated',
      eventId: U('evt_'),
      requestId: t.requestId,
      trackingId: t.trackingId,
      status: e,
      reason: e === 'FAILED' || e === 'RETURNED' ? t.reason : null,
      amount: t.amount,
      currency: t.currency,
      occurredAt: i || g(),
    },
    n = JSON.stringify(s),
    o = a ? P.randomBytes(32).toString('hex') : J(n),
    d = async (f) => {
      let u = 0;
      try {
        u = (
          await fetch(c.payoutWebhook, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-signature': o,
              'x-event-id': s.eventId,
            },
            body: n,
            signal: AbortSignal.timeout(1e4),
          })
        ).status;
      } catch {
        u = 0;
      }
      !a && (u < 200 || u > 299) && f < 5 && m(2 ** f, () => d(f + 1));
    };
  (d(0),
    !a &&
      h('payout', t.scen, 'dupWh') &&
      m(p(0.5, 4), () =>
        fetch(c.payoutWebhook, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-signature': o,
            'x-event-id': s.eventId,
          },
          body: n,
        }).catch(() => {}),
      ));
}
function T(t, e, a) {
  ((t.status = e),
    a && (t.reason = a),
    (t.updatedAt = g()),
    t.history.push({ status: e, at: t.updatedAt }));
}
function X(t) {
  let e = t.scen;
  m(p(0.5, 2), () => {
    (T(t, 'PROCESSING'), v(t, 'PROCESSING'));
  });
  let i = h('payout', e, 'slow') ? p(120, 600) : p(3, 30);
  m(i, () => {
    let s = null;
    if (
      (t.type === 'IBAN' && !Y(t.destination) && (s = 'INVALID_IBAN'),
      t.type === 'CRYPTO' && !H(t.destination) && (s = 'INVALID_ADDRESS'),
      s
        ? T(t, 'FAILED', s)
        : e && e.includes('fail')
          ? T(t, 'FAILED', 'BANK_REJECTED')
          : T(t, 'SUCCEEDED'),
      t.status === 'SUCCEEDED' && (t.executed = !0),
      h('payout', e, 'missWh')
        ? t.events.push('final-webhook-missing')
        : v(t, t.status),
      t.status === 'SUCCEEDED' &&
        h('payout', e, 'forgeWh') &&
        (t.events.push('forged-failed-webhook'),
        m(p(1, 3), () => v(t, 'FAILED', { forged: !0 }))),
      h('payout', e, 'staleWh'))
    ) {
      t.events.push('stale-processing-webhook');
      let o = t.history.find((d) => d.status === 'PROCESSING');
      m(p(1, 4), () => v(t, 'PROCESSING', { occurredAt: o ? o.at : g() }));
    }
    t.status === 'SUCCEEDED' &&
      t.type === 'IBAN' &&
      h('payout', e, 'returned') &&
      m(p(30, 180), () => {
        (T(t, 'RETURNED', 'ACCOUNT_CLOSED'),
          t.events.push('returned'),
          v(t, 'RETURNED'));
      });
  });
}
async function q(t, e, a, i) {
  let s = a.pathname.split('/').filter(Boolean);
  if (t.method === 'POST' && s[1] === 'transfers' && s.length === 2) {
    let { requestId: n, type: o, destination: d, amount: f, currency: u } = i;
    if (typeof n != 'string' || n.length < 8 || n.length > 64)
      return r(e, 400, { error: 'INVALID_REQUEST_ID' });
    let l = N.get(n);
    if (l) return r(e, 200, C(l));
    if (!['IBAN', 'CRYPTO'].includes(o))
      return r(e, 400, { error: 'INVALID_TYPE' });
    if (o === 'IBAN' && (u !== 'IRR' || !F(f)))
      return r(e, 400, {
        error: 'INVALID_AMOUNT',
        message: 'IBAN transfers are IRR integers',
      });
    if (o === 'CRYPTO' && (u !== 'USDT' || !Z(f)))
      return r(e, 400, {
        error: 'INVALID_AMOUNT',
        message: 'CRYPTO transfers are USDT decimal strings',
      });
    if (typeof d != 'string' || !d)
      return r(e, 400, { error: 'INVALID_DESTINATION' });
    let I = $('payout'),
      y = null;
    if (
      (I
        ? (y = I.includes('e503-after')
            ? 'after'
            : I.includes('e503-before')
              ? 'before'
              : null)
        : _() < B('e503') && (y = _() < 0.5 ? 'before' : 'after'),
      y === 'before')
    )
      return r(e, 503, { error: 'UPSTREAM_UNAVAILABLE' });
    let E = {
      requestId: n,
      trackingId: U('TRK'),
      type: o,
      destination: d,
      amount: String(f),
      currency: u,
      status: 'ACCEPTED',
      createdAt: g(),
      updatedAt: g(),
      history: [{ status: 'ACCEPTED', at: g() }],
      events: [],
      scen: I,
      executed: !1,
      hiddenUntil: 0,
    };
    return (
      N.set(n, E),
      X(E),
      y === 'after'
        ? (E.events.push('503-after-create'),
          (E.hiddenUntil = Date.now() + (90 * 1e3) / c.scale),
          r(e, 503, { error: 'UPSTREAM_UNAVAILABLE' }))
        : h('payout', I, 'timeout')
          ? (E.events.push('timeout-after-create'),
            (E.hiddenUntil = Date.now() + (90 * 1e3) / c.scale),
            m(35, () => t.socket.destroy()))
          : r(e, 202, C(E))
    );
  }
  if (t.method === 'GET' && s[1] === 'transfers' && s[2]) {
    let n = N.get(s[2]);
    return !n || Date.now() < n.hiddenUntil
      ? r(e, 404, { error: 'NOT_FOUND' })
      : r(e, 200, C(n));
  }
  return r(e, 404, { error: 'NOT_FOUND' });
}
function O(t) {
  return new Date(new Date(t).getTime() + 126e5).toISOString().slice(0, 10);
}
function tt(t, e, a) {
  let i = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334],
    s = t <= 1600 ? 0 : 979;
  t -= t <= 1600 ? 621 : 1600;
  let n = e > 2 ? t + 1 : t,
    o =
      365 * t +
      Math.floor((n + 3) / 4) -
      Math.floor((n + 99) / 100) +
      Math.floor((n + 399) / 400) -
      80 +
      a +
      i[e - 1];
  ((s += 33 * Math.floor(o / 12053)),
    (o %= 12053),
    (s += 4 * Math.floor(o / 1461)),
    (o %= 1461),
    o > 365 && ((s += Math.floor((o - 1) / 365)), (o = (o - 1) % 365)));
  let d = o < 186 ? 1 + Math.floor(o / 31) : 7 + Math.floor((o - 186) / 30),
    f = 1 + (o < 186 ? o % 31 : (o - 186) % 30);
  return `${s}/${String(d).padStart(2, '0')}/${String(f).padStart(2, '0')}`;
}
var L = (t) =>
    String(t).replace(
      /\d/g,
      (e) => '\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9'[e],
    ),
  et = (t) => String(t).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
  k = new Map();
function nt(t) {
  let e = /^\d{4}-\d{2}-\d{2}$/.test(t || '') ? t : O(g()),
    [a, i, s] = e.split('-').map(Number),
    n = tt(a, i, s),
    o = [];
  for (let u of S.values())
    u.status === 'VERIFIED' &&
      O(u.verifiedAt) === e &&
      o.push({
        type: '\u0648\u0627\u0631\u06CC\u0632 \u062F\u0631\u06AF\u0627\u0647',
        ref: u.refId,
        amount: u.amount,
        desc: `\u067E\u0631\u062F\u0627\u062E\u062A \u0627\u06CC\u0646\u062A\u0631\u0646\u062A\u06CC ${u.token}`,
      });
  for (let u of N.values()) {
    if (u.type !== 'IBAN') continue;
    let l = u.history.find((y) => y.status === 'SUCCEEDED');
    l &&
      O(l.at) === e &&
      (o.push({
        type: '\u0628\u0631\u062F\u0627\u0634\u062A \u067E\u0627\u06CC\u0627',
        ref: u.trackingId,
        amount: '-' + u.amount,
        desc: `\u0627\u0646\u062A\u0642\u0627\u0644 \u0628\u0647 ${u.destination}`,
      }),
      o.push({
        type: '\u06A9\u0627\u0631\u0645\u0632\u062F',
        ref: u.trackingId,
        amount: '-2500',
        desc: '\u06A9\u0627\u0631\u0645\u0632\u062F \u0627\u0646\u062A\u0642\u0627\u0644 \u067E\u0627\u06CC\u0627',
      }));
    let I = u.history.find((y) => y.status === 'RETURNED');
    I &&
      O(I.at) === e &&
      o.push({
        type: '\u0628\u0631\u06AF\u0634\u062A \u067E\u0627\u06CC\u0627',
        ref: u.trackingId,
        amount: u.amount,
        desc: '\u0639\u0648\u062F\u062A \u0648\u062C\u0647 - \u062D\u0633\u0627\u0628 \u0645\u0633\u062F\u0648\u062F',
      });
  }
  (k.has(e) ||
    k.set(e, {
      type: '\u0648\u0627\u0631\u06CC\u0632 \u062F\u0631\u06AF\u0627\u0647',
      ref: String(Math.floor(p(1e9, 9e9))),
      amount: String(Math.floor(p(5, 50)) * 1e5),
      desc: '\u067E\u0631\u062F\u0627\u062E\u062A \u0627\u06CC\u0646\u062A\u0631\u0646\u062A\u06CC \u0646\u0627\u0645\u0634\u062E\u0635',
    }),
    o.push(k.get(e)));
  let d = [];
  return (
    o.forEach((u, l) => {
      let I = l % 3 === 0 ? '000' + u.ref : l % 3 === 1 ? ` ${u.ref} ` : u.ref,
        y = u.amount.startsWith('-'),
        E = y ? u.amount.slice(1) : u.amount,
        R = (y ? '-' : '') + et(E);
      l % 2 === 0 && (R = L(R).replace(/,/g, '\u066C'));
      let M = [l + 1, l % 4 === 0 ? L(n) : n, I, u.type, `"${R}"`, u.desc];
      (d.push(M), l % 5 === 2 && d.push(M.slice()));
    }),
    '\uFEFF' +
      [
        '\u0631\u062F\u06CC\u0641,\u062A\u0627\u0631\u06CC\u062E,\u0634\u0645\u0627\u0631\u0647 \u067E\u06CC\u06AF\u06CC\u0631\u06CC,\u0646\u0648\u0639 \u062A\u0631\u0627\u06A9\u0646\u0634,\u0645\u0628\u0644\u063A (\u0631\u06CC\u0627\u0644),\u0634\u0631\u062D',
        ...d.map((u) => u.join(',')),
      ].join(`\r
`) +
      `\r
`
  );
}
async function st(t, e, a, i) {
  if (!c.adminKey || t.headers['x-admin-key'] !== c.adminKey)
    return r(e, 404, { error: 'NOT_FOUND' });
  let s = a.pathname;
  if (s === '/__admin/payouts')
    return r(
      e,
      200,
      [...N.values()].map((n) => ({
        ...C(n),
        type: n.type,
        executed: n.executed,
        events: n.events,
        history: n.history,
      })),
    );
  if (s === '/__admin/payments')
    return r(
      e,
      200,
      [...S.values()].map((n) => ({
        token: n.token,
        orderId: n.orderId,
        amount: n.amount,
        status: n.status,
        refId: n.refId,
        events: n.events,
      })),
    );
  if (s === '/__admin/scenario' && t.method === 'POST') {
    for (let n of ['payment', 'payout'])
      Array.isArray(i[n]) && A[n].push(...i[n]);
    return r(e, 200, {
      queued: { payment: A.payment.length, payout: A.payout.length },
    });
  }
  return s === '/__admin/chaos' && t.method === 'POST'
    ? (w[i.profile] && (c.chaos = i.profile), r(e, 200, { chaos: c.chaos }))
    : s === '/__admin/reset' && t.method === 'POST'
      ? (S.clear(),
        N.clear(),
        (A.payment = []),
        (A.payout = []),
        k.clear(),
        r(e, 200, { ok: !0 }))
      : s === '/__admin/config'
        ? r(e, 200, {
            chaos: c.chaos,
            scale: c.scale,
            payoutWebhook: c.payoutWebhook,
            seed: c.seed,
          })
        : r(e, 404, { error: 'NOT_FOUND' });
}
var x = V.createServer(async (t, e) => {
  let a = Date.now(),
    i = new K(t.url, 'http://x');
  e.on('finish', () =>
    console.log(
      `${new Date().toISOString()} ${t.method} ${i.pathname} ${e.statusCode} ${Date.now() - a}ms`,
    ),
  );
  let s = t.method === 'POST' ? await j(t) : {};
  if (s.__invalid) return r(e, 400, { error: 'INVALID_JSON' });
  try {
    return i.pathname === '/health'
      ? r(e, 200, { ok: !0 })
      : i.pathname.startsWith('/__admin/')
        ? st(t, e, i, s)
        : i.pathname.startsWith('/psp/')
          ? Q(t, e, i, s)
          : i.pathname.startsWith('/payout/')
            ? q(t, e, i, s)
            : r(e, 404, { error: 'NOT_FOUND' });
  } catch (n) {
    return (console.error(n), r(e, 500, { error: 'INTERNAL' }));
  }
});
x.requestTimeout = 0;
x.listen(c.port, () =>
  console.log(
    `simulator listening on :${c.port} chaos=${c.chaos} scale=${c.scale}`,
  ),
);
