/**
 * Gambeta Club - Mercado Pago Checkout Pro.
 * Función serverless de Vercel: POST /api/mercadopago
 *
 * Body que manda la tienda:
 *   {
 *     name: "Nombre Apellido",
 *     items: [{ id: "ARG-001", size: "L", quantity: 2 }],
 *     shipping: { cp: "2400", type: "S" | "D" }      // opcional (solo si eligió envío por Correo)
 *   }
 *
 * Por seguridad el precio NUNCA se toma del navegador: la función lee cada camiseta en Supabase
 * (precio vigente, promo y stock) y vuelve a cotizar el envío con Correo Argentino.
 * Así nadie puede pagar $1 editando el JavaScript de la página.
 *
 * Variables de entorno (Vercel > Project > Settings > Environment Variables):
 *   MP_ACCESS_TOKEN   Access Token de Mercado Pago (obligatoria)
 *   SITE_URL          opcional, ej: https://gambetaclub.vercel.app (si falta, se usa el origen de la petición)
 *   SUPABASE_URL / SUPABASE_ANON_KEY   opcionales (por defecto, las de la tienda)
 */

var correo = require("./cotizar.js");

var SUPABASE_URL = process.env.SUPABASE_URL || "https://imyzlrtysbwyrgaqasps.supabase.co";
var SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlteXpscnR5c2J3eXJnYXFhc3BzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwOTY4MTksImV4cCI6MjEwNzY3MjgxOX0.ldp6ZryfOp0N53qBEW3vmtRh3mfBM81H4X55MQP0WSY";
var MP_URL = "https://api.mercadopago.com/checkout/preferences";
var TIMEOUT_MS = 8000;
var MAX_LINES = 30, MAX_QTY = 20;

function fail(status, message) { var e = new Error(message); e.status = status; return e; }

function timedFetch(url, opts) {
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
  return fetch(url, Object.assign({}, opts, { signal: ctl.signal })).finally(function () { clearTimeout(t); });
}

// Dominio al que vuelve el cliente: SITE_URL, o el origen de la petición.
function siteBase(req) {
  var base = process.env.SITE_URL || req.headers.origin || (req.headers.host ? "https://" + req.headers.host : "");
  base = String(base).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+$/i.test(base)) throw fail(500, "No se pudo determinar el dominio de la tienda. Definí SITE_URL en Vercel.");
  return base;
}

async function loadProducts(ids) {
  var list = ids.map(function (id) { return '"' + id + '"'; }).join(",");
  var url = SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/products?active=eq.true&select=id,name,price,promo_price,stock_sizes,images&id=in.(" + encodeURIComponent(list) + ")";
  var r = await timedFetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY } });
  if (!r.ok) throw fail(502, "No pudimos verificar los precios. Probá de nuevo en un momento.");
  var rows = await r.json(), map = {};
  rows.forEach(function (p) { map[p.id] = p; });
  return map;
}

function parseBody(req) {
  var b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
  return b && typeof b === "object" ? b : {};
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.setHeader("Allow", "POST, OPTIONS"); return res.status(204).end(); }
  if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); return res.status(405).json({ error: "Método no permitido" }); }

  try {
    var token = process.env.MP_ACCESS_TOKEN;
    if (!token) throw fail(503, "El pago con Mercado Pago todavía no está disponible. Elegí transferencia o efectivo.");

    var body = parseBody(req);
    var name = String(body.name || "").trim().slice(0, 80);
    var raw = Array.isArray(body.items) ? body.items : [];
    if (!raw.length || raw.length > MAX_LINES) throw fail(400, "El carrito está vacío o es demasiado grande.");

    // 1) Validar el carrito y juntar cantidades por camiseta
    var lines = raw.map(function (i) {
      var id = String(i && i.id || ""), size = String(i && i.size || ""), qty = Number(i && i.quantity);
      if (!/^[\w.-]{1,40}$/.test(id) || !/^[A-Z0-9]{1,5}$/.test(size)) throw fail(400, "Hay un producto inválido en el carrito.");
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw fail(400, "Cantidad inválida en el carrito.");
      return { id: id, size: size, qty: qty };
    });
    var ids = lines.map(function (l) { return l.id; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    var products = await loadProducts(ids);

    // 2) Precio y stock reales, desde la base
    var items = [], shirts = 0, subtotal = 0;
    lines.forEach(function (l) {
      var p = products[l.id];
      if (!p) throw fail(409, "Una de las camisetas de tu carrito ya no está disponible. Actualizá la página.");
      var stock = Number(p.stock_sizes && p.stock_sizes[l.size]);
      var inCart = lines.filter(function (x) { return x.id === l.id && x.size === l.size; }).reduce(function (s, x) { return s + x.qty; }, 0);
      if (!(stock > 0) || inCart > stock) throw fail(409, p.name + " talle " + l.size + ": no hay stock suficiente.");
      var price = Number(p.promo_price) > 0 && Number(p.promo_price) < Number(p.price) ? Number(p.promo_price) : Number(p.price);
      var unit = Math.round(price);
      var item = { id: p.id + "-" + l.size, title: (p.name + " (Talle " + l.size + ")").slice(0, 250), description: "Camiseta " + p.name + ", talle " + l.size,
                   category_id: "fashion", quantity: l.qty, currency_id: "ARS", unit_price: unit };
      if (p.images && /^https:\/\//.test(p.images[0] || "")) item.picture_url = p.images[0];
      items.push(item); shirts += l.qty; subtotal += unit * l.qty;
    });

    // 3) Envío: se vuelve a cotizar acá, el costo que mande el navegador no se usa
    var shipping = null, ship = body.shipping;
    if (ship && ship.type) {
      var cp = String(ship.cp || "").trim();
      if (!/^[1-9]\d{3}$/.test(cp) || (ship.type !== "S" && ship.type !== "D")) throw fail(400, "Datos de envío inválidos.");
      var q = await correo.quote(cp, shirts);
      var opt = q.options.filter(function (o) { return o.type === ship.type; })[0];
      if (!opt) throw fail(409, "No encontramos esa modalidad de envío para tu código postal. Volvé a cotizar.");
      shipping = { cp: cp, type: ship.type, price: opt.price, label: opt.label, source: q.source };
      items.push({ id: "ENVIO-" + ship.type, title: (opt.label + " (CP " + cp + ")").slice(0, 250),
                   category_id: "services", quantity: 1, currency_id: "ARS", unit_price: opt.price });
    }

    // 4) Preferencia de pago
    var base = siteBase(req), https = /^https:\/\//.test(base) && !/localhost|127\.0\.0\.1/.test(base);
    var ref = "GC-" + Date.now().toString(36).toUpperCase();
    var preference = {
      items: items,
      payer: name ? { name: name } : undefined,
      back_urls: { success: base + "/?status=success", failure: base + "/?status=failure", pending: base + "/?status=pending" },
      external_reference: ref,
      statement_descriptor: "GAMBETA CLUB",
      metadata: { name: name, shirts: shirts, shipping_cp: shipping && shipping.cp, shipping_type: shipping && shipping.type }
    };
    if (https) preference.auto_return = "approved"; // Mercado Pago solo lo acepta con URL pública https

    var r = await timedFetch(MP_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "X-Idempotency-Key": ref + "-" + Math.random().toString(36).slice(2, 10) },
      body: JSON.stringify(preference)
    });
    var mp = await r.json().catch(function () { return {}; });
    if (!r.ok || !mp.init_point) {
      console.error("[mercadopago] error", r.status, JSON.stringify(mp).slice(0, 500));
      throw fail(502, "Mercado Pago no pudo generar el pago. Probá de nuevo o elegí otro medio.");
    }
    return res.status(200).json({
      id: mp.id, init_point: mp.init_point, sandbox_init_point: mp.sandbox_init_point,
      ref: ref, subtotal: subtotal, shipping: shipping ? shipping.price : 0, total: subtotal + (shipping ? shipping.price : 0)
    });
  } catch (e) {
    var status = e.status || (e.name === "AbortError" ? 504 : 500);
    if (!e.status) console.error("[mercadopago]", e);
    return res.status(status).json({ error: e.status ? e.message : (e.name === "AbortError" ? "Mercado Pago tardó demasiado. Probá de nuevo." : "No pudimos generar el pago. Probá de nuevo.") });
  }
};
