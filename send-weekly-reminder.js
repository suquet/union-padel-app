// /api/send-weekly-reminder.js
//
// Manda 2 correos por semana, uno por jugador confirmado:
//   - Viernes 12pm (hora de Toronto) -> recordatorio del LUNES (Court X / excepciones)
//   - Lunes 12pm (hora de Toronto)   -> recordatorio del MIÉRCOLES (The District)
//
// Se dispara por Vercel Cron (ver vercel.json) dos veces por semana en dos horas UTC
// distintas (para cubrir horario de verano e invierno sin tener que tocar el cron dos
// veces al año) — la función misma revisa la hora real de Toronto antes de mandar nada,
// así que solo UNA de esas dos invocaciones va a enviar de verdad.
//
// Variables de entorno necesarias en Vercel (Project Settings -> Environment Variables):
//   SUPABASE_URL                 -> https://ytwepofbiiqibwtnvbec.supabase.co (la misma del app)
//   SUPABASE_SERVICE_ROLE_KEY    -> Service Role key de Supabase (Project Settings -> API).
//                                   NUNCA la anon key -- esta sí puede saltarse RLS, y por
//                                   eso solo debe vivir aquí (servidor), nunca en el front.
//   RESEND_API_KEY               -> API key de Resend.
//   REMINDER_FROM_EMAIL          -> ej. "Union Padel <avisos@tudominio.com>" (tiene que ser
//                                   un dominio verificado en Resend -- ver instrucciones).
//   CRON_SECRET                  -> cualquier cadena larga random que tú inventes, para que
//                                   nadie más pueda disparar el endpoint a mano.
//
// Para probar sin mandar correos de verdad: pega ?dryRun=1 a la URL (ver abajo).
// Para forzar un tipo de sesión sin esperar al día/hora real: ?force=lunes o ?force=miercoles

const PAGO_COLLECTORS = [
  { label: "Pablo Cuevas (Fondo)", email: "pablocuevas2010@gmail.com", matchName: "Pablo Cuevas", forced4: true },
  { label: "Pablo Cuevas", email: "pablocuevas2010@gmail.com", matchName: "Pablo Cuevas", forced4: false },
  { label: "Rodrigo Diaz de Rivera", email: "rodrigo@diazderivera.com", matchName: "Rodrigo Diaz de Rivera", forced4: false },
  { label: "Mauricio Caso", email: "caso222@hotmail.com", matchName: "Mauricio Caso", forced4: false },
  { label: "Alejandro Ruiz", email: "alejandro.ruiz.mendez@gmail.com", matchName: "Alejandro Ruiz", minCourts: 4 },
  { label: "Oscar Arguelles", email: "oarguelles@gmail.com", matchName: "Oscar Arguelles", minCourts: 5 },
  { label: "Gerardo Castillo", email: "gerardo@keystonehomedesigns.com", matchName: "Gerardo Castillo", minCourts: 6 }
];
const FIXED_PAYERS_TO_FONDO = ["Luis Hurtado", "Mauricio Sierra", "Luis Ita", "Eduardo Sotomayor", "Jorge Vidal"];
const FONDO_LABEL = "Pablo Cuevas (Fondo)";
const FONDO_EMAIL = "pablocuevas2010@gmail.com";

// Mismas excepciones por única ocasión que en el index.html -- si agregas una ahí,
// cópiala aquí también (o mejor, muévanlas a una tabla en Supabase más adelante).
const SESSION_OVERRIDES = {
  "lunes|2026-09-07": { venue: "The District", zone: "Etobicoke", capacity: 24, price: 32, note: "Excepción por Labour Day weekend: Court X cerrado — se juega en The District, 6 canchas." }
};

// Fechas sin pádel (feriados). Mantener sincronizado con index.html y la tabla skipped_sessions.
const NO_SESSION_DATES = { "lunes|2026-10-12": "Thanksgiving" };

function normalizeName(n) { return (n || "").toLowerCase().trim().replace(/\s+/g, " "); }

function nowInToronto() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Toronto" }));
}
function dateKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

// Próxima ocurrencia de ese día de la semana (0=domingo … 1=lunes … 3=miércoles), a partir de HOY (incluye hoy).
function nextDow(dow, from) {
  var d = startOfDay(from);
  var diff = (dow - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function sessionOverride(type, key) { return SESSION_OVERRIDES[type + "|" + key] || null; }

function sessionInfo(type, targetDate) {
  var key = dateKey(targetDate);
  var ov = sessionOverride(type, key);
  return {
    type: type, date: targetDate, key: key,
    venue: (ov && ov.venue) || (type === "lunes" ? "Court X" : "The District"),
    zone: (ov && ov.zone) || (type === "lunes" ? "Oakville" : "Etobicoke"),
    price: (ov && ov.price) || (type === "lunes" ? 34 : 32),
    capacity: (ov && ov.capacity) || (type === "lunes" ? 28 : 24)
  };
}

// ---- Supabase (REST, sin SDK) ----
function sbHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json"
  };
}
async function sbSelect(table, query) {
  var url = process.env.SUPABASE_URL + "/rest/v1/" + table + "?" + query;
  var res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) throw new Error(table + " fetch failed: " + res.status + " " + (await res.text()));
  return res.json();
}

// ---- Algoritmo de canchas (mismo que index.html: buildCourts / computeNaturalOrder) ----
function effectiveRank(c, rankingList) {
  var live = rankingList.filter(function (r) { return normalizeName(r.name) === normalizeName(c.name); })[0];
  return live ? live.rank : c.rank;
}
function computeNaturalOrder(list, rankingList) {
  var remainder = list.length % 4;
  var pending = [];
  var pool = list.slice();
  if (remainder > 0) {
    var byTimeDesc = list.slice().sort(function (a, b) { return b.ts - a.ts; });
    var pendingIds = {};
    for (var p = 0; p < remainder; p++) pendingIds[byTimeDesc[p].id] = true;
    pending = pool.filter(function (c) { return pendingIds[c.id]; });
    pool = pool.filter(function (c) { return !pendingIds[c.id]; });
  }
  var rankSort = function (a, b) {
    var ra = effectiveRank(a, rankingList), rb = effectiveRank(b, rankingList);
    ra = ra == null ? Infinity : ra; rb = rb == null ? Infinity : rb;
    if (ra !== rb) return ra - rb;
    return a.ts - b.ts;
  };
  pool.sort(rankSort);
  var naturalBandLetter = {};
  pool.forEach(function (c, idx) { naturalBandLetter[c.id] = String.fromCharCode(65 + Math.floor(idx / 4)); });
  var droppers = pool.filter(function (c) {
    var entry = rankingList.filter(function (r) { return normalizeName(r.name) === normalizeName(c.name); })[0];
    if (!entry || !(entry.pending_drop_count > 0)) return false;
    var dropLetter = entry.pending_drop_from_court;
    return !dropLetter || naturalBandLetter[c.id] === dropLetter;
  });
  droppers.forEach(function (person) {
    var curIdx = pool.indexOf(person);
    var targetIdx = Math.min(curIdx + 4, pool.length - 1);
    if (targetIdx > curIdx) { pool.splice(curIdx, 1); pool.splice(targetIdx, 0, person); }
  });
  pending.sort(function (a, b) { return a.ts - b.ts; });
  return pool.concat(pending);
}
function buildCourts(confirmedList, rankingList) {
  var pinned = confirmedList.filter(function (c) { return c.manual_order != null; }).sort(function (a, b) { return a.manual_order - b.manual_order; });
  var total = confirmedList.length;
  var finalList = new Array(total);
  if (pinned.length) {
    var unpinned = confirmedList.filter(function (c) { return c.manual_order == null; });
    var naturalUnpinned = computeNaturalOrder(unpinned, rankingList);
    pinned.forEach(function (pn) {
      var idx = Math.min(Math.max(pn.manual_order - 1, 0), total - 1);
      while (finalList[idx] != null && idx < total - 1) idx++;
      finalList[idx] = pn;
    });
    var ni = 0;
    for (var i = 0; i < total; i++) { if (finalList[i] == null) { finalList[i] = naturalUnpinned[ni]; ni++; } }
  } else {
    finalList = computeNaturalOrder(confirmedList, rankingList);
  }
  var courts = [];
  var rankSortCourt = function (a, b) {
    var ra = effectiveRank(a, rankingList), rb = effectiveRank(b, rankingList);
    ra = ra == null ? Infinity : ra; rb = rb == null ? Infinity : rb;
    if (ra !== rb) return ra - rb;
    return a.ts - b.ts;
  };
  for (var j = 0; j < finalList.length; j += 4) {
    var court = finalList.slice(j, j + 4);
    court.sort(rankSortCourt);
    courts.push(court);
  }
  return courts;
}

// ---- Pagos (mismo que index.html: computeMondayPayers) ----
function computeMondayPayers(sortedConfirmed, courtsCount) {
  var active = PAGO_COLLECTORS.filter(function (c) { return !c.minCourts || courtsCount > c.minCourts; });
  var excludeSet = {};
  active.forEach(function (c) { excludeSet[normalizeName(c.matchName)] = true; });
  var fixedSet = {};
  FIXED_PAYERS_TO_FONDO.forEach(function (n) { fixedSet[normalizeName(n)] = true; });
  var fixedPlaying = sortedConfirmed.filter(function (p) { return fixedSet[normalizeName(p.name)] && !excludeSet[normalizeName(p.name)]; });
  var payers = sortedConfirmed.filter(function (p) { return !excludeSet[normalizeName(p.name)] && !fixedSet[normalizeName(p.name)]; });
  var collectors = active.map(function (c) {
    var isPlaying = sortedConfirmed.some(function (p) { return normalizeName(p.name) === normalizeName(c.matchName); });
    var needed = c.forced4 ? 4 : (isPlaying ? 3 : 4);
    if (c.forced4) needed = Math.max(0, needed - fixedPlaying.length);
    return { label: c.label, email: c.email, needed: needed };
  }).filter(function (c) { return c.needed > 0; });

  var assignments = collectors.map(function (c) { return { label: c.label, email: c.email, needed: c.needed, players: [] }; });
  var queue = payers.slice();
  var progressed = true;
  while (queue.length && progressed) {
    progressed = false;
    for (var k = 0; k < assignments.length; k++) {
      if (!queue.length) break;
      if (assignments[k].players.length < assignments[k].needed) { assignments[k].players.push(queue.shift()); progressed = true; }
    }
  }
  var payerToCollector = {};
  fixedPlaying.forEach(function (p) { payerToCollector[normalizeName(p.name)] = { label: FONDO_LABEL, email: FONDO_EMAIL }; });
  assignments.forEach(function (a) { a.players.forEach(function (p) { payerToCollector[normalizeName(p.name)] = { label: a.label, email: a.email }; }); });
  return payerToCollector; // name(normalizado) -> { label, email }  (a quién le paga)
}

// ---- Email (Resend, vía REST) ----
async function sendEmail(to, subject, html) {
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.REMINDER_FROM_EMAIL, to: [to], subject: subject, html: html })
  });
  var body = await res.json().catch(function () { return {}; });
  return { ok: res.ok, status: res.status, body: body };
}

function fmtDateEs(d) {
  return d.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
}

function emailHtml(playerName, sess, courtLetter, payLine) {
  var dayLabel = sess.type === "lunes" ? "Lunes" : "Miércoles";
  return (
    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0B0F1A;color:#E8ECF4">' +
    '<div style="font-size:12px;letter-spacing:2px;color:#D6F23C;font-weight:700;margin-bottom:6px">UNION PADEL</div>' +
    '<h2 style="margin:0 0 4px;color:#fff">' + dayLabel + ' ' + fmtDateEs(sess.date) + '</h2>' +
    '<div style="color:#8C97B3;font-size:13px;margin-bottom:18px">' + sess.venue + ', ' + sess.zone + ' · 8:00–9:30 PM</div>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
    '<tr><td style="padding:8px 0;color:#8C97B3">Nombre</td><td style="padding:8px 0;text-align:right;font-weight:600">' + playerName + '</td></tr>' +
    '<tr style="border-top:1px solid #262B3A"><td style="padding:8px 0;color:#8C97B3">Cancha</td><td style="padding:8px 0;text-align:right;font-weight:600">' + (courtLetter || "Por confirmar") + '</td></tr>' +
    '<tr style="border-top:1px solid #262B3A"><td style="padding:8px 0;color:#8C97B3">Importe</td><td style="padding:8px 0;text-align:right;font-weight:600">' + payLine + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:20px;font-size:11.5px;color:#8C97B3">Union Padel Hub — este es un recordatorio automático semanal.</div>' +
    '</div>'
  );
}

module.exports = async function handler(req, res) {
  try {
    var dryRun = req.query.dryRun === "1";
    var forced = req.query.force; // "lunes" | "miercoles" (para pruebas)

    var authHeader = req.headers["authorization"];
    var isCronCall = authHeader === "Bearer " + process.env.CRON_SECRET;
    if (!isCronCall && !dryRun) {
      return res.status(401).json({ error: "No autorizado. Usa ?dryRun=1 para probar manualmente." });
    }

    var now = nowInToronto();
    var day = now.getDay(); // 1=lunes, 5=viernes
    var hour = now.getHours();

    var type = forced;
    if (!type) {
      var isFridayNoon = day === 5 && hour === 12;
      var isMondayNoon = day === 1 && hour === 12;
      if (isFridayNoon) type = "lunes";
      else if (isMondayNoon) type = "miercoles";
      else return res.status(200).json({ skipped: true, reason: "No es viernes/lunes 12pm hora Toronto", nowToronto: now.toString() });
    }

    var targetDow = type === "lunes" ? 1 : 3;
    var targetDate = nextDow(targetDow, now);
    var sess = sessionInfo(type, targetDate);
    if (NO_SESSION_DATES[type + "|" + sess.key]) {
      return res.status(200).json({ skipped: true, reason: "Sin pádel esa fecha: " + NO_SESSION_DATES[type + "|" + sess.key], date: sess.key });
    }

    // Evita mandar dos veces la misma semana (por el doble-cron de DST, o un reintento)
    if (!dryRun) {
      var already = await sbSelect("email_log", "select=id&session_type=eq." + type + "&session_date=eq." + sess.key + "&limit=1");
      if (already.length) return res.status(200).json({ skipped: true, reason: "Ya se mandó para " + sess.key });
    }

    var confRows = await sbSelect(
      "confirmations",
      "select=id,player_id,player_name,confirmed_at,cancelled,manual_order,rank_at_confirm&session_type=eq." + type + "&session_date=eq." + sess.key + "&cancelled=eq.false&order=confirmed_at.asc"
    );
    var confirmed = confRows.slice(0, sess.capacity).map(function (r) {
      return { id: r.id, name: r.player_name, ts: new Date(r.confirmed_at).getTime(), manual_order: r.manual_order, rank: r.rank_at_confirm };
    });

    if (!confirmed.length) {
      return res.status(200).json({ skipped: true, reason: "Nadie confirmado todavía para " + sess.key });
    }

    var rankingRows = await sbSelect("ranking", "select=name,rank,pending_drop_count,pending_drop_from_court");
    var courts = buildCourts(confirmed, rankingRows);
    var courtLetterByName = {};
    courts.forEach(function (court, ci) {
      court.forEach(function (p) { courtLetterByName[normalizeName(p.name)] = String.fromCharCode(65 + ci); });
    });

    var payerToCollector = {};
    if (type === "lunes") {
      payerToCollector = computeMondayPayers(confirmed, courts.length);
    }

    var playersRows = await sbSelect("players", "select=id,name,email");
    var emailByPlayerId = {};
    playersRows.forEach(function (p) { if (p.email) emailByPlayerId[p.id] = p.email; });

    var sent = [], skipped = [];
    for (var i = 0; i < confirmed.length; i++) {
      var c = confirmed[i];
      var email = c.id ? emailByPlayerId[c.id] : null;
      if (!email) { skipped.push({ name: c.name, reason: "sin correo registrado" }); continue; }

      var courtLetter = courtLetterByName[normalizeName(c.name)];
      var payLine;
      if (type === "lunes") {
        var pay = payerToCollector[normalizeName(c.name)];
        if (pay) payLine = "$" + sess.price + " CAD a " + pay.label;
        else payLine = "$" + sess.price + " CAD (cobra un cobrador — pendiente de asignar)";
      } else {
        payLine = "$" + sess.price + " CAD directo en " + sess.venue;
      }

      var html = emailHtml(c.name, sess, courtLetter, payLine);
      var subject = "🎾 Tu cancha del " + (type === "lunes" ? "lunes" : "miércoles") + " " + sess.key;

      if (dryRun) {
        sent.push({ name: c.name, email: email, court: courtLetter, pay: payLine });
      } else {
        var result = await sendEmail(email, subject, html);
        if (result.ok) sent.push({ name: c.name, email: email });
        else skipped.push({ name: c.name, reason: "Resend error " + result.status, detail: result.body });
      }
    }

    if (!dryRun) {
      await fetch(process.env.SUPABASE_URL + "/rest/v1/email_log", {
        method: "POST",
        headers: Object.assign({}, sbHeaders(), { Prefer: "return=minimal" }),
        body: JSON.stringify({ session_type: type, session_date: sess.key, sent_count: sent.length })
      });
    }

    return res.status(200).json({ dryRun: dryRun, type: type, sessionDate: sess.key, sentCount: sent.length, sent: sent, skipped: skipped });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
};
