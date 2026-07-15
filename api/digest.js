// Resumen diario de deadlines por correo (Resend), disparado por el cron de
// Vercel a las 8:00 AM Bogotá (13:00 UTC, ver vercel.json).
//
// Env vars:
//   CLICKUP_TOKEN   (requerida) token de ClickUp para leer las tareas
//   RESEND_API_KEY  (requerida para enviar) API key de Resend
//   DIGEST_TO       (requerida para enviar) destinatarios, separados por coma
//   DIGEST_FROM     remitente — default "Task Dispatcher <contabilidad@colorads.co>"
//   DIGEST_AREAS    áreas a incluir: "disenio" (default), "all", o lista "disenio,paid"
//   CRON_SECRET     si está definida, el endpoint exige Bearer/?key= (Vercel la envía solo)
//
// Modo prueba: GET /api/digest?dry=1 devuelve el correo sin enviarlo.

const SPACE_ID = "90130971239";
const OPS_FOLDER_ID = "901318180618";
const TZ = "America/Bogota";
const AREA_LABELS = { paid: "📣 Paid Media", disenio: "🎨 Diseño", estrategia: "🧠 Estrategia", admin: "📋 Admin", desweb: "💻 Web" };

function listKeyFor(listName) {
  const n = listName.toLowerCase();
  if (n.includes("paid")) return "paid";
  if (n.includes("dise")) return "disenio";
  if (n.includes("estrategia")) return "estrategia";
  if (n.includes("admin")) return "admin";
  if (n.includes("desarrollo") || n.includes("web")) return "desweb";
  return null;
}

function splitEmoji(folderName) {
  const parts = folderName.trim().split(/\s+/);
  if (parts.length > 1 && /^[^\p{L}\p{N}]+$/u.test(parts[0])) {
    return { emoji: parts[0], name: parts.slice(1).join(" ") };
  }
  return { emoji: "🏢", name: folderName.trim() };
}

function bogotaDate(ms) {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

module.exports = async (req, res) => {
  // Solo el cron de Vercel o quien tenga el secreto puede disparar el envío
  const secret = process.env.CRON_SECRET;
  const authed = secret
    ? (req.headers.authorization === `Bearer ${secret}` || req.query.key === secret)
    : !!req.headers["x-vercel-cron"] || req.query.dry === "1";
  if (!authed) return res.status(401).json({ err: "No autorizado" });

  const token = process.env.CLICKUP_TOKEN;
  if (!token) return res.status(503).json({ err: "Falta CLICKUP_TOKEN en las env vars de Vercel" });

  const cuHeaders = { Authorization: token, "Content-Type": "application/json" };
  const cu = async (path) => {
    const r = await fetch(`https://api.clickup.com/api/v2/${path}`, { headers: cuHeaders });
    if (!r.ok) throw new Error(`ClickUp ${r.status} en ${path}`);
    return r.json();
  };

  try {
    const areasCfg = (process.env.DIGEST_AREAS || "disenio").trim();
    const areas = areasCfg === "all" ? Object.keys(AREA_LABELS) : areasCfg.split(",").map(s => s.trim()).filter(k => AREA_LABELS[k]);
    const multiArea = areas.length > 1;

    // 1. Estructura: listas de las áreas pedidas en todos los clientes activos
    const folderData = await cu(`space/${SPACE_ID}/folder?archived=false`);
    const sources = [];
    for (const f of folderData.folders || []) {
      if (f.id === OPS_FOLDER_ID || /desactivad[oa]\s*$/i.test(f.name)) continue;
      const client = splitEmoji(f.name);
      for (const l of f.lists || []) {
        const key = listKeyFor(l.name);
        if (key && areas.includes(key)) sources.push({ listId: l.id, area: key, client });
      }
    }

    // 2. Tareas abiertas de cada lista
    const perList = await Promise.all(sources.map(async (s) => {
      try {
        const d = await cu(`list/${s.listId}/task`);
        return (d.tasks || []).map(t => ({ task: t, area: s.area, client: s.client }));
      } catch { return []; }
    }));
    const items = perList.flat();

    // 3. Clasificar por fecha (día de Bogotá)
    const today = bogotaDate(Date.now());
    const tomorrow = bogotaDate(Date.now() + 86400000);
    const late = [], dueToday = [], dueTomorrow = [];
    let noDate = 0;
    for (const it of items) {
      if (!it.task.due_date) { noDate++; continue; }
      const d = bogotaDate(Number(it.task.due_date));
      if (d < today) late.push(it);
      else if (d === today) dueToday.push(it);
      else if (d === tomorrow) dueTomorrow.push(it);
    }

    // 4. Agrupar por persona
    const groups = new Map();
    const addTo = (it, kind) => {
      const a = (it.task.assignees || [])[0];
      const key = a ? String(a.id) : "zz-sin-asignar";
      if (!groups.has(key)) groups.set(key, { name: a ? a.username : "Sin asignar", late: [], today: [], tomorrow: [] });
      groups.get(key)[kind].push(it);
    };
    late.forEach(it => addTo(it, "late"));
    dueToday.forEach(it => addTo(it, "today"));
    dueTomorrow.forEach(it => addTo(it, "tomorrow"));

    const areaLabel = multiArea ? "Todas las áreas" : AREA_LABELS[areas[0]];
    const areaName = areaLabel.replace(/^[^\p{L}]+\s*/u, ""); // sin emoji, para el asunto
    const allClear = !late.length && !dueToday.length;
    const subject = allClear
      ? `✅ ${areaName} al día — sin vencidas ni entregas hoy`
      : `📋 ${areaName} hoy: ${late.length} vencida${late.length !== 1 ? "s" : ""} · ${dueToday.length} para hoy`;

    // 5. HTML del correo
    const taskLine = (it, color) => {
      const t = it.task;
      const days = Math.round((Date.parse(today) - Date.parse(bogotaDate(Number(t.due_date)))) / 86400000);
      const when = color === "#c0392b" ? `${days} día${days !== 1 ? "s" : ""} vencida` : (color === "#b9770e" ? "hoy" : "mañana");
      const link = t.url && t.url.startsWith("https://") ? t.url : "#";
      return `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #eee;font-size:14px;color:#333">
          <a href="${esc(link)}" style="color:#2c3e50;text-decoration:none;font-weight:500">${esc(t.name)}</a>
          <span style="color:#999;font-size:12px"> — ${it.client.emoji} ${esc(it.client.name)}${multiArea ? ` · ${AREA_LABELS[it.area]}` : ""}</span>
        </td>
        <td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">
          <span style="color:${color};font-size:12px;font-weight:600">${when}</span>
        </td>
      </tr>`;
    };

    const sortedGroups = [...groups.values()].sort((a, b) => (b.late.length - a.late.length) || (b.today.length - a.today.length));
    let sections = "";
    for (const g of sortedGroups) {
      if (!g.late.length && !g.today.length && !g.tomorrow.length) continue;
      sections += `<h3 style="margin:22px 0 4px;font-size:15px;color:#2c3e50">${esc(g.name)}
        ${g.late.length ? `<span style="background:#fdecea;color:#c0392b;font-size:11px;padding:2px 8px;border-radius:10px;margin-left:6px">${g.late.length} vencida${g.late.length !== 1 ? "s" : ""}</span>` : ""}
      </h3>
      <table style="width:100%;border-collapse:collapse">
        ${g.late.map(it => taskLine(it, "#c0392b")).join("")}
        ${g.today.map(it => taskLine(it, "#b9770e")).join("")}
        ${g.tomorrow.map(it => taskLine(it, "#888")).join("")}
      </table>`;
    }
    if (allClear && !dueTomorrow.length) {
      sections = `<p style="font-size:14px;color:#27ae60;margin-top:20px">Sin tareas vencidas ni entregas para hoy o mañana. 🎉</p>`;
    }

    const html = `<div style="max-width:600px;margin:0 auto;font-family:-apple-system,Segoe UI,sans-serif;padding:24px">
      <p style="font-size:12px;color:#999;margin-bottom:4px">Color Ads — Task Dispatcher · ${new Date().toLocaleDateString("es-CO", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" })}</p>
      <h2 style="margin:0 0 6px;font-size:19px;color:#1a1a2e">Deadlines de ${areaLabel}</h2>
      <p style="font-size:13px;color:#666;margin:0">
        <strong style="color:#c0392b">${late.length} vencidas</strong> ·
        <strong style="color:#b9770e">${dueToday.length} para hoy</strong> ·
        ${dueTomorrow.length} para mañana · ${items.length} abiertas en total${noDate ? ` · <span style="color:#999">${noDate} sin fecha</span>` : ""}
      </p>
      ${sections}
      <p style="margin-top:28px"><a href="https://color-ads-dispatcher.vercel.app" style="font-size:13px;color:#4f8ef7">Abrir el tablero →</a></p>
    </div>`;

    const stats = { areas, abiertas: items.length, vencidas: late.length, hoy: dueToday.length, manana: dueTomorrow.length, sinFecha: noDate };

    if (req.query.dry === "1") return res.status(200).json({ dry: true, subject, stats, html });

    if (!process.env.RESEND_API_KEY || !process.env.DIGEST_TO) {
      return res.status(503).json({ err: "Faltan RESEND_API_KEY o DIGEST_TO en las env vars de Vercel", stats });
    }

    const send = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.DIGEST_FROM || "Task Dispatcher <contabilidad@colorads.co>",
        to: process.env.DIGEST_TO.split(",").map(s => s.trim()),
        subject,
        html,
      }),
    });
    const sendBody = await send.json().catch(() => ({}));
    if (!send.ok) return res.status(502).json({ err: "Resend rechazó el envío", detail: sendBody, stats });

    res.status(200).json({ sent: true, id: sendBody.id, subject, stats });
  } catch (e) {
    res.status(500).json({ err: String(e.message || e) });
  }
};
