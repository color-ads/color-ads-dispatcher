// Recordatorio diario del portal DOM: correo a los suscriptores (almacenados
// en la tarea-almacén de Operaciones) con las tareas de DOM organizadas por
// deadline. Disparado por el cron de Vercel; fechas en hora de Bogotá.
const DOM_FOLDER_ID = "901318180640";
const SUBS_TASK_ID = "wdv5t9datm";
const SUBS_PREFIX = "Suscriptores (gestionado por el app):\n";
const parseSubs = (raw) => {
  const s = String(raw || "");
  const body = s.includes("\n") ? s.slice(s.indexOf("\n") + 1) : s;
  try { const a = JSON.parse(body); return Array.isArray(a) ? a : []; } catch { return []; }
};

const PROJECT_PREFIX = "dom:";
const PERSON_PREFIX = "dom-p:";
const slugify = (x) => String(x || "").toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9\-áéíóúñ]/g, "").slice(0, 30);
const TZ = "America/Bogota";
const PORTAL_URL = "https://color-ads-dispatcher.vercel.app/dom";

function listKeyFor(n) {
  n = n.toLowerCase();
  if (n.includes("paid")) return "📣 Paid";
  if (n.includes("dise")) return "🎨 Diseño";
  if (n.includes("estrategia")) return "🧠 Estrategia";
  if (n.includes("admin")) return "📋 Admin";
  if (n.includes("desarrollo") || n.includes("web")) return "💻 Web";
  return null;
}
const projName = (s) => s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const bogDate = (ms) => new Date(Number(ms)).toLocaleDateString("en-CA", { timeZone: TZ });

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const fromCron = req.headers["x-vercel-cron"];
  const authorized = secret
    ? (auth === `Bearer ${secret}` || req.query.key === secret)
    : !!fromCron || req.query.dry === "1";
  if (!authorized) return res.status(401).json({ err: "No autorizado" });

  const token = process.env.CLICKUP_TOKEN;
  if (!token) return res.status(503).json({ err: "Falta CLICKUP_TOKEN" });

  const cu = async (path) => {
    const r = await fetch(`https://api.clickup.com/api/v2/${path}`, { headers: { Authorization: token } });
    if (!r.ok) throw new Error(`ClickUp ${r.status} en ${path}`);
    return r.json();
  };

  try {
    // 1. Suscriptores
    const st = await cu(`task/${SUBS_TASK_ID}`);
    const subs = parseSubs(st.description || st.text_content).filter((x) => x && x.email);
    if (!subs.length) return res.status(200).json({ sent: false, reason: "Sin suscriptores" });

    // 2. Tareas abiertas de DOM
    const folder = await cu(`folder/${DOM_FOLDER_ID}`);
    const lists = (folder.lists || []).map((l) => ({ id: l.id, area: listKeyFor(l.name) })).filter((l) => l.area);
    const perList = await Promise.all(lists.map(async (l) => {
      const d = await cu(`list/${l.id}/task`);
      return (d.tasks || []).map((t) => ({ ...t, _area: l.area }));
    }));
    const tasks = perList.flat();

    const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: TZ });
    const late = tasks.filter((t) => t.due_date && bogDate(t.due_date) < today);
    const dueToday = tasks.filter((t) => t.due_date && bogDate(t.due_date) === today);
    const dueTomorrow = tasks.filter((t) => t.due_date && bogDate(t.due_date) === tomorrow);
    const noDate = tasks.filter((t) => !t.due_date);

    const fmtDay = (ms) => new Date(Number(ms)).toLocaleDateString("es-CO", { timeZone: TZ, day: "numeric", month: "short" });
    const daysLate = (ms) => Math.round((Date.parse(today) - Date.parse(bogDate(ms))) / 86400000);
    const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const whoOf = (t) => {
      const a = (t.assignees || [])[0];
      if (a) return a.username;
      const p = (t.tags || []).map((x) => x.name || "").find((n) => n.startsWith(PERSON_PREFIX));
      return p ? p.slice(PERSON_PREFIX.length).split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : null;
    };
    const row = (t, extra) => {
      const a = { username: whoOf(t) };
      const proj = (t.tags || []).map((x) => x.name || "").find((n) => n.startsWith(PROJECT_PREFIX));
      return `<tr>
        <td style="padding:9px 0;border-bottom:1px solid #f0f0f0">
          <div style="font-size:14px;color:#1a1a1a;font-weight:500">${esc(t.name)}</div>
          <div style="font-size:12px;color:#8a8a8a;margin-top:2px">${esc(t._area)}${proj ? ` · <span style="color:#5b48c2;font-weight:600">${esc(projName(proj.slice(PROJECT_PREFIX.length)))}</span>` : ""}${a ? ` · ${esc(a.username)}` : ""}</div>
        </td>
        <td style="padding:9px 0 9px 12px;border-bottom:1px solid #f0f0f0;text-align:right;white-space:nowrap;font-size:12.5px;font-weight:700">${extra}</td>
      </tr>`;
    };
    const section = (title, color, items, extraFn) => !items.length ? "" : `
      <h3 style="font-size:14px;color:${color};margin:22px 0 4px">${title} (${items.length})</h3>
      <table style="width:100%;border-collapse:collapse">${items.map((t) => row(t, extraFn(t))).join("")}</table>`;

    const allClear = !late.length && !dueToday.length;
    const subject = allClear
      ? `✅ DOM al día — sin vencidas ni entregas hoy`
      : `🎯 DOM hoy: ${late.length} vencida${late.length !== 1 ? "s" : ""} · ${dueToday.length} para hoy`;

    const baseHtml = (mine) => `
    <div style="max-width:600px;margin:0 auto;font-family:-apple-system,Segoe UI,sans-serif;padding:28px 22px;color:#1a1a1a">
      <div style="font-size:12.5px;color:#8a8a8a">DOM · Tablero Color Ads · ${new Date().toLocaleDateString("es-CO", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" })}</div>
      <h1 style="font-size:21px;margin:6px 0 4px">🎯 Recordatorio diario DOM</h1>
      <div style="font-size:14px;margin-bottom:6px">
        <span style="color:#c0392b;font-weight:700">${late.length} vencidas</span> ·
        <span style="color:#b9770e;font-weight:700">${dueToday.length} para hoy</span> ·
        ${dueTomorrow.length} para mañana · ${tasks.length} abiertas en total <span style="color:#8a8a8a">· ${noDate.length} sin fecha</span>
      </div>
      ${allClear ? `<p style="font-size:14px;color:#178040;font-weight:600">✅ Todo al día — nada vencido ni para hoy.</p>` : ""}
      ${mine && mine.length ? `<div style="background:#f5f2ff;border:1px solid #ddd3f5;border-radius:10px;padding:4px 14px 10px;margin-top:16px">${section("👤 Tus tareas asignadas", "#5b48c2", mine.sort((a, b) => (a.due_date ? Number(a.due_date) : Infinity) - (b.due_date ? Number(b.due_date) : Infinity)), (t) => t.due_date ? (bogDate(t.due_date) < today ? `<span style="color:#c0392b">${daysLate(t.due_date)}d vencida</span>` : bogDate(t.due_date) === today ? `<span style="color:#b9770e">Hoy</span>` : fmtDay(t.due_date)) : `<span style="color:#d98324">Sin fecha</span>`)}</div>` : ""}
      ${section("🔴 Vencidas", "#c0392b", late.sort((a, b) => Number(a.due_date) - Number(b.due_date)), (t) => `<span style="color:#c0392b">${daysLate(t.due_date)} día${daysLate(t.due_date) !== 1 ? "s" : ""} vencida</span>`)}
      ${section("🟠 Para hoy", "#b9770e", dueToday, () => `<span style="color:#b9770e">Hoy</span>`)}
      ${section("🟡 Para mañana", "#a08a1e", dueTomorrow, () => `<span style="color:#a08a1e">Mañana</span>`)}
      <div style="margin-top:26px;padding-top:14px;border-top:1px solid #eee">
        <a href="${PORTAL_URL}" style="display:inline-block;background:#2f5fd0;color:#fff;text-decoration:none;font-size:13.5px;font-weight:600;padding:10px 18px;border-radius:8px">Abrir el tablero DOM →</a>
        <p style="font-size:11.5px;color:#a0a0a0;margin-top:14px">Recibes este correo porque te suscribiste en el portal DOM de Color Ads. Para dejar de recibirlo, responde este correo.</p>
      </div>
    </div>`;

    const mineOf = (sub) => {
      const slug = slugify(sub.who);
      if (!slug) return [];
      return tasks.filter((t) => (t.tags || []).some((x) => (x.name || "") === PERSON_PREFIX + slug));
    };
    const stats = { suscriptores: subs.length, abiertas: tasks.length, vencidas: late.length, hoy: dueToday.length, manana: dueTomorrow.length, sinFecha: noDate.length };
    if (req.query.dry === "1") return res.status(200).json({ dry: true, subject, stats, emails: subs.map((s) => s.email), personalizadas: Object.fromEntries(subs.map((s) => [s.email, mineOf(s).length])), html: baseHtml(mineOf(subs[0])) });

    const key = process.env.RESEND_API_KEY;
    if (!key) return res.status(503).json({ err: "Falta RESEND_API_KEY" });
    const from = process.env.DIGEST_FROM || "Portal DOM · Color Ads <contabilidad@colorads.co>";
    const results = [];
    for (const s of subs) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [s.email], subject, html: baseHtml(mineOf(s)) }),
      });
      const d = await r.json().catch(() => ({}));
      results.push({ email: s.email, ok: r.ok, id: d.id || d.message });
    }
    return res.status(200).json({ sent: results.filter((x) => x.ok).length, total: subs.length, subject, stats, results });
  } catch (e) {
    res.status(502).json({ err: String(e.message || e) });
  }
}
