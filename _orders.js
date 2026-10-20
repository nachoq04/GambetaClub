/**
 * Gambeta Club - utilidades compartidas de las funciones de pedidos.
 * El guion bajo en el nombre hace que Vercel NO lo publique como una ruta.
 *
 * Variables de entorno:
 *   ORDERS_SECRET  clave interna que autoriza a Vercel a registrar pedidos y confirmar pagos en Supabase.
 *                  Si falta, la tienda sigue vendiendo pero los pedidos no se guardan en el panel.
 *   SUPABASE_URL / SUPABASE_ANON_KEY   opcionales (por defecto, las de la tienda)
 */
var correo = require("./cotizar.js");

var SUPABASE_URL = (process.env.SUPABASE_URL || "https://imyzlrtysbwyrgaqasps.supabase.co").replace(/\/+$/, "");
var SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlteXpscnR5c2J3eXJnYXFhc3BzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwOTY4MTksImV4cCI6MjEwNzY3MjgxOX0.ldp6ZryfOp0N53qBEW3vmtRh3mfBM81H4X55MQP0WSY";
var TIMEOUT_MS = 8000;
var MAX_LINES = 30, MAX_QTY = 20;
var TRANSFER_OFF = 0.05;

function fail(status, message) { var e = new Error(message); e.status = status; return e; }

function timedFetch(url, opts) {
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
  return fetch(url, Object.assign({}, opts, { signal: ctl.signal })).finally(function () { clearTimeout(t); });
}

function parseBody(req) {
  var b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
  return b && typeof b === "object" ? b : {};
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
  var url = SUPABASE_URL + "/rest/v1/products?active=eq.true&select=id,name,price,promo_price,stock_sizes,images&id=in.(" + encodeURIComponent(list) + ")";
  var r = await timedFetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY } });
  if (!r.ok) throw fail(502, "No pudimos verificar los precios. Probá de nuevo en un momento.");
  var rows = await r.json(), map = {};
  rows.forEach(function (p) { map[p.id] = p; });
  return map;
}

/**
 * Valida el carrito contra la base (precio vigente, promo y stock). El precio NUNCA viene del navegador.
 * body.items = [{ id, size, quantity }]
 * Devuelve { details: [{ id, name, size, qty, unit, picture }], shirts, subtotal }
 */
async function buildCart(body) {
  var raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length || raw.length > MAX_LINES) throw fail(400, "El carrito está vacío o es demasiado grande.");
  var lines = raw.map(function (i) {
    var id = String(i && i.id || ""), size = String(i && i.size || ""), qty = Number(i && i.quantity);
    if (!/^[\w.-]{1,40}$/.test(id) || !/^[A-Z0-9]{1,5}$/.test(size)) throw fail(400, "Hay un producto inválido en el carrito.");
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw fail(400, "Cantidad inválida en el carrito.");
    return { id: id, size: size, qty: qty };
  });
  var ids = lines.map(function (l) { return l.id; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
  var products = await loadProducts(ids);

  var details = [], shirts = 0, subtotal = 0;
  lines.forEach(function (l) {
    var p = products[l.id];
    if (!p) throw fail(409, "Una de las camisetas de tu carrito ya no está disponible. Actualizá la página.");
    var stock = Number(p.stock_sizes && p.stock_sizes[l.size]);
    var inCart = lines.filter(function (x) { return x.id === l.id && x.size === l.size; }).reduce(function (s, x) { return s + x.qty; }, 0);
    if (!(stock > 0) || inCart > stock) throw fail(409, p.name + " talle " + l.size + ": no hay stock suficiente.");
    var price = Number(p.promo_price) > 0 && Number(p.promo_price) < Number(p.price) ? Number(p.promo_price) : Number(p.price);
    var unit = Math.round(price);
    details.push({ id: p.id, name: p.name, size: l.size, qty: l.qty, unit: unit, picture: p.images && /^https:\/\//.test(p.images[0] || "") ? p.images[0] : "" });
    shirts += l.qty; subtotal += unit * l.qty;
  });
  return { details: details, shirts: shirts, subtotal: subtotal };
}

/** Vuelve a cotizar el envío del lado del servidor. body.shipping = { cp, type: "S" | "D" } o null. */
async function buildShipping(body, shirts) {
  var ship = body.shipping;
  if (!ship || !ship.type) return null;
  var cp = String(ship.cp || "").trim();
  if (!/^[1-9]\d{3}$/.test(cp) || (ship.type !== "S" && ship.type !== "D")) throw fail(400, "Datos de envío inválidos.");
  var q = await correo.quote(cp, shirts);
  var opt = q.options.filter(function (o) { return o.type === ship.type; })[0];
  if (!opt) throw fail(409, "No encontramos esa modalidad de envío para tu código postal. Volvé a cotizar.");
  return { cp: cp, type: ship.type, price: opt.price, label: opt.label, source: q.source };
}

function transferPrice(n) { return Math.round(n * (1 - TRANSFER_OFF)); }

/* ---------- Supabase (funciones protegidas con ORDERS_SECRET) ---------- */
function ordersEnabled() { return !!process.env.ORDERS_SECRET; }

async function rpc(fn, args) {
  var r = await timedFetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ p_secret: process.env.ORDERS_SECRET }, args))
  });
  var txt = await r.text(), data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  if (!r.ok) { var e = new Error("Supabase " + fn + " " + r.status + ": " + String(txt).slice(0, 200)); e.status = r.status; throw e; }
  return data;
}

/** Guarda el pedido para el panel. Nunca rompe la compra: si falla, solo lo deja en el log. */
async function recordOrder(order) {
  if (!ordersEnabled()) { console.warn("[pedidos] falta ORDERS_SECRET: el pedido " + order.ref + " no se guardó en el panel"); return false; }
  try { await rpc("create_order", { p: order }); return true; }
  catch (e) { console.error("[pedidos] no se pudo guardar " + order.ref + ":", e.message); return false; }
}

function newRef() { return "GC-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(); }

module.exports = {
  SUPABASE_URL: SUPABASE_URL, fail: fail, timedFetch: timedFetch, parseBody: parseBody, siteBase: siteBase,
  buildCart: buildCart, buildShipping: buildShipping, transferPrice: transferPrice,
  ordersEnabled: ordersEnabled, rpc: rpc, recordOrder: recordOrder, newRef: newRef
};
