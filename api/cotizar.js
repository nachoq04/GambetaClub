/**
 * Gambeta Club - cotizador de envíos con la API de MiCorreo (Correo Argentino).
 * Función serverless de Vercel: POST /api/cotizar  { cp: "1704", qty: 2 }
 *
 * Variables de entorno (Vercel > Project > Settings > Environment Variables):
 *   MICORREO_USER         usuario de la API (te lo da Correo Argentino)
 *   MICORREO_PASS         contraseña de la API
 *   MICORREO_CUSTOMER_ID  tu customerId de MiCorreo, ej: "0000550997"
 *   MICORREO_ORIGIN_CP    CP de origen (por defecto "3103")
 *   MICORREO_ENV          "prod" (por defecto) o "test"
 *
 * Sin variables de MiCorreo se usan los precios fijos por zona (source: "zones").
 * Con variables, cotiza en vivo; si Correo Argentino falla, vuelve a los precios por zona
 * (source: "fallback", se avisa que es estimado) para que el carrito nunca se bloquee.
 * Libertador San Martín (CP 3103) siempre usa su tarifa local.
 */

var limited = require("./_limit.js");

var BASES = {
  prod: "https://api.correoargentino.com.ar/micorreo/v1",
  test: "https://apitest.correoargentino.com.ar/micorreo/v1"
};
var TIMEOUT_MS = 4500;          // por llamada; la función de Vercel Hobby corta a los 10 s
var REFRESH_MARGIN_MS = 5 * 60 * 1000; // renovar el token 5 minutos antes de que venza
var FALLBACK_TTL_MS = 20 * 60 * 1000;  // si la API no informa un vencimiento legible

// El token vive en memoria mientras la instancia siga caliente.
var cache = { token: null, exp: 0, pending: null };

function cfg() {
  var env = String(process.env.MICORREO_ENV || "prod").toLowerCase() === "test" ? "test" : "prod";
  return {
    base: BASES[env],
    user: process.env.MICORREO_USER,
    pass: process.env.MICORREO_PASS,
    customerId: process.env.MICORREO_CUSTOMER_ID,
    origin: String(process.env.MICORREO_ORIGIN_CP || "3103")
  };
}

function timedFetch(url, opts) {
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
  opts = Object.assign({}, opts, { signal: ctl.signal });
  return fetch(url, opts).finally(function () { clearTimeout(t); });
}

function HttpError(status, body) {
  var e = new Error("MiCorreo respondió " + status);
  e.status = status; e.body = body; return e;
}

// "2022-04-26 21:16:20" (hora de Argentina, UTC-3) -> epoch ms
function parseExpires(s) {
  if (!s) return 0;
  var iso = /([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? String(s).replace(" ", "T")
          : String(s).replace(" ", "T") + "-03:00";
  var t = Date.parse(iso);
  return isNaN(t) ? 0 : t;
}

async function fetchToken(c) {
  var basic = Buffer.from(c.user + ":" + c.pass).toString("base64");
  var r = await timedFetch(c.base + "/token", { method: "POST", headers: { Authorization: "Basic " + basic } });
  if (!r.ok) throw HttpError(r.status);
  var j = await r.json();
  if (!j || !j.token) throw new Error("MiCorreo no devolvió token");
  var exp = parseExpires(j.expires) || (Date.now() + FALLBACK_TTL_MS + REFRESH_MARGIN_MS);
  cache.token = j.token; cache.exp = exp;
  return j.token;
}

async function getToken(c, force) {
  if (!force && cache.token && Date.now() < cache.exp - REFRESH_MARGIN_MS) return cache.token;
  if (!cache.pending) {                      // varias cotizaciones a la vez comparten un solo pedido de token
    cache.pending = fetchToken(c).finally(function () { cache.pending = null; });
  }
  return cache.pending;
}

async function requestRates(c, body, token) {
  var r = await timedFetch(c.base + "/rates", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw HttpError(r.status);
  return r.json();
}

function dimensionsFor(qty) {
  return {
    weight: Math.max(250, qty * 250),
    height: Math.min(150, Math.max(5, qty * 4)),
    width: 25,
    length: 32
  };
}

var LABELS = { S: "Correo Argentino a Sucursal", D: "Correo Argentino a Domicilio" };

// Deja la tarifa más barata de cada modalidad, con el precio en pesos enteros.
function normalize(rates, cp) {
  var best = {};
  (rates || []).forEach(function (r) {
    var type = r && r.deliveredType, price = Math.round(Number(r && r.price));
    if ((type !== "S" && type !== "D") || !isFinite(price) || price <= 0) return;
    if (!best[type] || price < best[type].price) {
      best[type] = { type: type, label: LABELS[type], product: r.productName || "", price: price, eta: etaFor(cp) };
    }
  });
  return ["S", "D"].filter(function (t) { return best[t]; }).map(function (t) { return best[t]; });
}

/* ---------- Tarifas por zona ----------
   Mientras no haya credenciales de MiCorreo, estos son los precios oficiales de la tienda.
   Precio de 1 camiseta (250 g) según el CP de destino. Cada camiseta extra suma un 15%.
   EDITÁ ACÁ los montos de cada zona (S = a sucursal, D = a domicilio). */
var LOCAL_CP = "3103";                 // Villa Libertador San Martín: zona exclusiva, solo entrega en la ciudad
var LOCAL = { D: 2000 };
var ZONES = {
  1: { S: 3000,  D: 5000  }, // cercano: Entre Ríos, Santa Fe, Córdoba
  2: { S: 5000,  D: 7000  }, // AMBA y Buenos Aires
  3: { S: 7000,  D: 8000 }, // Centro y Cuyo, NOA, NEA, Mesopotamia
  4: { S: 8000,  D: 9000 }  // Patagonia
};
function zoneFor(cp) {
  var n = parseInt(cp, 10);
  if ((n >= 2000 && n <= 3299) || (n >= 5000 && n <= 5299)) return 1;
  if (n >= 8300) return 4;
  if (n < 2000 || (n >= 6000 && n < 8300)) return 2;
  return 3;
}
// Plazos estimados desde que despachamos (los define Correo Argentino)
var ETA = { 1: "3 a 6 días hábiles", 2: "3 a 7 días hábiles", 3: "3 a 7 días hábiles", 4: "3 a 7 días hábiles" };
function etaFor(cp) { return ETA[zoneFor(cp)]; }
function round100(n) { return Math.round(n / 100) * 100; }
function localOptions(qty) {
  return [{ type: "D", label: "Envío en Villa Libertador San Martín", product: "", local: true, eta: "1 a 2 días hábiles", price: round100(LOCAL.D * (1 + 0.15 * (qty - 1))) }];
}
function zoneOptions(cp, qty) {
  if (cp === LOCAL_CP) return localOptions(qty);
  var z = ZONES[zoneFor(cp)], k = 1 + 0.15 * (qty - 1);
  return ["S", "D"].map(function (t) {
    return { type: t, label: LABELS[t], product: "", price: round100(z[t] * k), eta: etaFor(cp) };
  });
}

// Cotiza un envío y devuelve { source, cp, qty, options }. Nunca falla: si Correo no responde, usa tarifas de respaldo.
// La usan /api/cotizar (el carrito) y /api/mercadopago (para fijar el costo de envío del lado del servidor).
async function quote(cp, qty) {
  var c = cfg();
  var fallback = function (reason) {
    console.warn("[cotizar] fallback:", reason);
    return { source: "fallback", cp: cp, qty: qty, options: zoneOptions(cp, qty) };
  };
  if (cp === LOCAL_CP) return { source: "zones", cp: cp, qty: qty, options: localOptions(qty) };
  if (!c.user || !c.pass || !c.customerId) return { source: "zones", cp: cp, qty: qty, options: zoneOptions(cp, qty) };

  var payload = {
    customerId: String(c.customerId),
    postalCodeOrigin: c.origin,
    postalCodeDestination: cp,
    dimensions: dimensionsFor(qty)
  };
  try {
    var token = await getToken(c, false), data;
    try {
      data = await requestRates(c, payload, token);
    } catch (e) {
      if (e.status !== 401) throw e;       // token vencido o revocado: se renueva y se reintenta una vez
      cache.token = null;
      data = await requestRates(c, payload, await getToken(c, true));
    }
    var options = normalize(data && data.rates, cp);
    if (!options.length) return fallback("MiCorreo no devolvió tarifas para " + cp);
    return { source: "micorreo", cp: cp, qty: qty, options: options };
  } catch (e) {
    return fallback(e.status ? "MiCorreo " + e.status : (e.name === "AbortError" ? "timeout" : e.message));
  }
}

function send(res, status, data) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(data);
}

async function handler(req, res) {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "POST, OPTIONS"); return res.status(204).end(); }
  if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); return send(res, 405, { error: "Método no permitido" }); }

  if (limited(req, res, "cotizar", 40, 60000)) return;
  var body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  body = body || {};
  var cp = String(body.cp == null ? "" : body.cp).trim();
  var qty = Number(body.qty);
  if (!/^[1-9]\d{3}$/.test(cp)) return send(res, 400, { error: "Ingresá un código postal de 4 dígitos." });
  if (!Number.isInteger(qty) || qty < 1 || qty > 60) return send(res, 400, { error: "Cantidad de camisetas inválida." });

  return send(res, 200, await quote(cp, qty));
}

module.exports = handler;
module.exports.quote = quote;
