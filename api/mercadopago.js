'use strict';

/**
 * Gambeta Club · Mercado Pago Checkout Pro (Vercel Serverless, Node 18+)
 *
 *   POST /api/mercadopago            -> crea la preferencia y devuelve { id, init_point, external_reference }
 *   GET  /api/mercadopago?payment_id -> verifica un pago { approved, status, external_reference }
 *
 * Variables de entorno (Vercel > Settings > Environment Variables):
 *   MP_ACCESS_TOKEN     (obligatoria)  Access Token de producción. Nunca va en el código ni en el navegador.
 *   CATALOG_CSV_URL     (recomendada)  El mismo link CSV publicado de tu Google Sheet. Con esto el servidor
 *                                      toma precio, nombre y stock del catálogo e ignora lo que mande el navegador.
 *   SITE_URL            (opcional)     https://tu-dominio.com  (sin barra final). Si no está, usa el origen del pedido.
 *   MP_WEBHOOK_URL      (opcional)     URL pública que recibe las notificaciones de pago de Mercado Pago.
 *   MAX_SHIPPING_COST   (opcional)     Tope aceptado para el envío, en pesos. Por defecto 60000.
 *   ALLOW_CLIENT_PRICES (no recomendada) "true" para confiar en los precios que manda el navegador.
 *
 * Si tus productos viven en Supabase en vez del Sheet, reemplazá el cuerpo de loadCatalog()
 * por una consulta a tu tabla y devolvé el mismo Map (id -> { id, name, price, stock }).
 */

const crypto = require('crypto');

const MP_API = 'https://api.mercadopago.com';
const MAX_ITEMS = 30;
const MAX_QTY = 20;
const MAX_SHIPPING = Number(process.env.MAX_SHIPPING_COST) || 60000;
const CATALOG_TTL = 60 * 1000;           // el catálogo se reusa 1 minuto
const CATALOG_STALE = 10 * 60 * 1000;    // si el Sheet falla, se tolera una copia de hasta 10 minutos

let catalogCache = { at: 0, map: null };

/* ---------------------------- utilidades ---------------------------- */

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https:\/\/[^\s]{4,480}$/i.test(s) ? s : '';
}

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

async function fetchT(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctl.signal })); }
  finally { clearTimeout(t); }
}

function baseUrl(req) {
  const env = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^\s/]+$/i.test(env)) return env;
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (/^https?:\/\/[^\s/]+$/i.test(origin)) return origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return `${proto}://${host}`;
}

/* ---------------------------- catálogo ---------------------------- */

function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const COLS = { id: 'id', nombre: 'name', precio: 'price', stocktalles: 'stock', talles: 'stock', estado: 'estado' };

function buildCatalog(text) {
  const rows = parseCsv(String(text).replace(/^\uFEFF/, ''));
  const map = new Map();
  if (rows.length < 2) return map;
  const keys = rows[0].map((h) => COLS[norm(h)] || null);
  for (const r of rows.slice(1)) {
    const o = {};
    keys.forEach((k, i) => { if (k) o[k] = (r[i] || '').trim(); });
    if (o.estado !== 'Activo' || !o.id || !o.name) continue;
    // mismo criterio que la tienda: "$45,000" y "45.000" valen 45000
    const price = parseInt(String(o.price || '').replace(/[.,]\d{1,2}$/, '').replace(/\D/g, ''), 10);
    if (!(price > 0)) continue;
    const stock = {};
    String(o.stock || '').split(',').forEach((s) => {
      const [a, b] = s.split(':'); const k = (a || '').trim();
      if (k) { const n = parseInt(b, 10); stock[k] = n > 0 ? n : 0; }
    });
    map.set(o.id, { id: o.id, name: o.name, price, stock });
  }
  return map;
}

async function loadCatalog() {
  const url = process.env.CATALOG_CSV_URL;
  if (!url) return null;
  const now = Date.now();
  if (catalogCache.map && now - catalogCache.at < CATALOG_TTL) return catalogCache.map;
  try {
    const r = await fetchT(url, { headers: { 'Cache-Control': 'no-cache' } }, 8000);
    if (!r.ok) throw new Error('CSV HTTP ' + r.status);
    const map = buildCatalog(await r.text());
    if (!map.size) throw new Error('catálogo vacío');
    catalogCache = { at: now, map };
    return map;
  } catch (e) {
    console.error('[mp] catálogo:', e.message);
    if (catalogCache.map && now - catalogCache.at < CATALOG_STALE) return catalogCache.map;
    throw new Error('CATALOG_UNAVAILABLE');
  }
}

/* ---------------------------- verificación de pago ---------------------------- */

async function verifyPayment(req, res, token) {
  const id = new URL(req.url, 'http://x').searchParams.get('payment_id') || '';
  if (!/^\d{5,20}$/.test(id)) return send(res, 400, { error: 'Pago inválido.' });
  try {
    const r = await fetchT(`${MP_API}/v1/payments/${id}`, { headers: { Authorization: `Bearer ${token}` } }, 10000);
    if (r.status === 404) return send(res, 404, { approved: false, status: 'not_found' });
    if (!r.ok) { console.error('[mp] verificación HTTP', r.status); return send(res, 502, { error: 'No pudimos verificar el pago.' }); }
    const p = await r.json();
    return send(res, 200, { approved: p.status === 'approved', status: p.status, external_reference: p.external_reference || null });
  } catch (e) {
    console.error('[mp] verificación:', e.message);
    return send(res, 502, { error: 'No pudimos verificar el pago.' });
  }
}

/* ---------------------------- handler ---------------------------- */

module.exports = async function handler(req, res) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) {
    console.error('[mp] falta la variable de entorno MP_ACCESS_TOKEN');
    return send(res, 500, { error: 'El pago online no está disponible por el momento.' });
  }

  if (req.method === 'GET') return verifyPayment(req, res, token);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'Método no permitido.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return send(res, 400, { error: 'Pedido inválido.' });

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length || rawItems.length > MAX_ITEMS) return send(res, 400, { error: 'Tu carrito está vacío o es demasiado grande.' });

  const name = clean((body.buyer && body.buyer.name) || body.name, 80);
  if (!name) return send(res, 400, { error: 'Falta tu nombre.' });
  const delivery = clean(body.delivery, 60);

  let shipping = Number(body.shipping_cost || 0);
  if (!Number.isFinite(shipping) || shipping < 0 || shipping > MAX_SHIPPING) return send(res, 400, { error: 'El costo de envío no es válido.' });
  shipping = Math.round(shipping);

  /* --- items: precio, nombre y stock salen del catálogo, no del navegador --- */
  let catalog;
  try { catalog = await loadCatalog(); }
  catch (e) { return send(res, 503, { error: 'No pudimos validar el stock. Probá de nuevo en un momento.' }); }
  if (!catalog && process.env.ALLOW_CLIENT_PRICES !== 'true') {
    console.error('[mp] falta CATALOG_CSV_URL: sin catálogo no se aceptan precios del navegador');
    return send(res, 500, { error: 'El pago online no está disponible por el momento.' });
  }

  const items = [];
  const wanted = new Map();
  for (const it of rawItems) {
    const id = clean(it && it.id, 64);
    const size = clean(it && it.size, 12);
    const qty = Number(it && it.quantity);
    if (!id || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return send(res, 400, { error: 'Hay un producto con datos inválidos.' });

    let title, price;
    if (catalog) {
      const p = catalog.get(id);
      if (!p) return send(res, 409, { error: 'Una de las camisetas ya no está disponible.' });
      if (Object.keys(p.stock).length) {
        if (!size) return send(res, 400, { error: `Falta elegir el talle de ${p.name}.` });
        const avail = p.stock[size];
        if (avail === undefined) return send(res, 409, { error: `El talle ${size} no existe para ${p.name}.` });
        const key = id + '|' + size;
        const sum = (wanted.get(key) || 0) + qty;
        wanted.set(key, sum);
        if (sum > avail) return send(res, 409, { error: `No hay stock suficiente de ${p.name} en talle ${size}.` });
      }
      title = p.name + (size ? ` (Talle ${size})` : '');
      price = p.price;
    } else {
      title = clean(it.title, 200);
      price = Number(it.unit_price);
      if (!title || !(price > 0) || price > 5000000) return send(res, 400, { error: 'Hay un producto con datos inválidos.' });
    }

    const picture = safeUrl(it.picture_url);
    items.push({
      id,
      title: clean(title, 250),
      ...(size && { description: `Talle ${size}` }),
      quantity: qty,
      currency_id: 'ARS',
      unit_price: price,
      ...(picture && { picture_url: picture }),
    });
  }
  if (shipping > 0) items.push({ id: 'envio', title: 'Envío a domicilio', quantity: 1, currency_id: 'ARS', unit_price: shipping });

  /* --- preferencia --- */
  const base = baseUrl(req);
  const ref = 'GC-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const preference = {
    items,
    payer: { name },
    // MP agrega sus propios parámetros (status, payment_id...), por eso usamos mp_status y no "status"
    back_urls: {
      success: `${base}/?mp_status=success`,
      failure: `${base}/?mp_status=failure`,
      pending: `${base}/?mp_status=pending`,
    },
    ...(base.startsWith('https://') && { auto_return: 'approved' }),   // MP lo rechaza con http://localhost
    external_reference: ref,
    statement_descriptor: 'GAMBETA CLUB',
    metadata: { buyer_name: name, delivery, shipping_cost: shipping },
    ...(process.env.MP_WEBHOOK_URL && { notification_url: process.env.MP_WEBHOOK_URL }),
  };

  try {
    const r = await fetchT(`${MP_API}/checkout/preferences`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(preference),
    }, 12000);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.init_point) {
      console.error('[mp] preferencia rechazada', r.status, JSON.stringify(data).slice(0, 600));
      return send(res, 502, { error: 'No pudimos generar el pago. Probá de nuevo o elegí otro medio de pago.' });
    }
    return send(res, 200, { id: data.id, init_point: data.init_point, external_reference: ref });
  } catch (e) {
    console.error('[mp] error al crear la preferencia:', e.message);
    return send(res, 502, { error: 'No pudimos generar el pago. Probá de nuevo o elegí otro medio de pago.' });
  }
};
