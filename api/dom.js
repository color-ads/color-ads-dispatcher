// Portal cliente DOM — API limitada a la carpeta de DOM.
// Roles por código: DOM_ACCESS_CODE = solo lectura · DOM_EDIT_CODE = edición.
// Todas las llamadas salen con el token del servidor (CLICKUP_TOKEN) y CADA
// operación valida que el recurso pertenezca a DOM antes de tocarlo.
const DOM_FOLDER_ID = "901318180640";
const SUBS_TASK_ID = "wdv5t9datm"; // tarea-almacén de suscriptores (carpeta Operaciones)
const SUBS_PREFIX = "Suscriptores (gestionado por el app):\n";
const parseSubs = (raw) => {
  const s = String(raw || "");
  const body = s.includes("\n") ? s.slice(s.indexOf("\n") + 1) : s;
  try { const a = JSON.parse(body); return Array.isArray(a) ? a : []; } catch { return []; }
};

const SPACE_ID = "90130971239";
const PROJECT_PREFIX = "dom:";

function listKeyFor(listName) {
  const n = listName.toLowerCase();
  if (n.includes("paid")) return "paid";
  if (n.includes("dise")) return "disenio";
  if (n.includes("estrategia")) return "estrategia";
  if (n.includes("admin")) return "admin";
  if (n.includes("desarrollo") || n.includes("web")) return "desweb";
  return null;
}

const cleanWho = (w) => String(w || "").replace(/[<>"`]/g, "").trim().slice(0, 40) || "Equipo DOM";
const slugify = (s) => String(s || "").toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9\-áéíóúñ]/g, "").slice(0, 30);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Access-Code");
  if (req.method === "OPTIONS") return res.status(200).end();

  const viewCode = process.env.DOM_ACCESS_CODE;
  const editCode = process.env.DOM_EDIT_CODE;
  if (!viewCode && !editCode) return res.status(503).json({ err: "El acceso de cliente no está configurado (falta DOM_ACCESS_CODE en Vercel)" });
  const given = req.headers["x-access-code"] || "";
  const role = editCode && given === editCode ? "edit" : (viewCode && given === viewCode ? "view" : null);
  if (!role) return res.status(401).json({ err: "Código de acceso incorrecto" });

  const token = process.env.CLICKUP_TOKEN;
  if (!token) return res.status(503).json({ err: "Falta CLICKUP_TOKEN en Vercel" });

  const cu = async (path, method = "GET", body = null) => {
    const r = await fetch(`https://api.clickup.com/api/v2/${path}`, {
      method,
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.err || `ClickUp ${r.status}`);
    }
    return r.json().catch(() => ({}));
  };

  const domLists = async () => {
    const folder = await cu(`folder/${DOM_FOLDER_ID}`);
    const lists = {};
    for (const l of folder.lists || []) {
      const key = listKeyFor(l.name);
      if (key && !lists[key]) lists[key] = l.id;
    }
    return lists;
  };

  // Toda tarea usada en una operación debe vivir en la carpeta DOM
  const assertTaskInDom = async (tid) => {
    if (!/^[a-z0-9]+$/i.test(String(tid || ""))) throw new Error("task_id inválido");
    const t = await cu(`task/${tid}`);
    if (String(t.folder?.id) !== DOM_FOLDER_ID) { const e = new Error("Esa tarea no es de DOM"); e.forbid = true; throw e; }
    return t;
  };

  const projectsOf = (t) => (t.tags || [])
    .map((x) => x.name || "").filter((n) => n.startsWith(PROJECT_PREFIX)).map((n) => n.slice(PROJECT_PREFIX.length));

  const trimTask = (t, area) => ({
    id: t.id,
    name: t.name,
    area,
    status: { status: t.status?.status || "", color: t.status?.color || "#c3c7d0" },
    due_date: t.due_date || null,
    priority: t.priority ? Number(t.priority.id) || 3 : 3,
    projects: projectsOf(t),
    assignees: (t.assignees || []).map((a) => ({ username: a.username || "", initials: a.initials || "", color: a.color || "" })),
  });

  const spaceProjects = async () => {
    const d = await cu(`space/${SPACE_ID}/tag`);
    return (d.tags || []).map((t) => t.name).filter((n) => n.startsWith(PROJECT_PREFIX)).map((n) => n.slice(PROJECT_PREFIX.length)).sort();
  };

  try {
    // ================= LECTURA (ambos roles) =================
    if (req.method === "GET") {
      const action = req.query.action;

      if (action === "board") {
        const lists = await domLists();
        const area = req.query.area;
        const keys = area === "all" ? Object.keys(lists) : (lists[area] ? [area] : []);
        const [perList, projects] = await Promise.all([
          Promise.all(keys.map(async (k) => {
            const d = await cu(`list/${lists[k]}/task`);
            return (d.tasks || []).map((t) => trimTask(t, k));
          })),
          spaceProjects(),
        ]);
        return res.status(200).json({ role, areas: Object.keys(lists), projects, tasks: perList.flat() });
      }

      if (action === "comments") {
        const t = await assertTaskInDom(req.query.task_id);
        const c = await cu(`task/${t.id}/comment`);
        const comments = (c.comments || [])
          .map((x) => ({ ...(role === "edit" ? { id: x.id } : {}), user: x.user?.username || "", date: x.date, text: x.comment_text || "" }))
          .sort((a, b) => Number(a.date) - Number(b.date));
        return res.status(200).json({ comments });
      }

      return res.status(400).json({ err: "Acción inválida" });
    }

    // ================= ESCRITURA (solo rol edición) =================
    if (req.method !== "POST") return res.status(405).json({ err: "Método no permitido" });
    const action = req.query.action;
    const b = req.body || {};

    // Suscripción al recordatorio diario — permitida con cualquier código válido
    if (action === "subscribe") {
      const email = String(b.email || "").trim().toLowerCase().slice(0, 100);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ err: "Correo inválido" });
      const t = await cu(`task/${SUBS_TASK_ID}`);
      const subs = parseSubs(t.description || t.text_content);
      if (!subs.some((x) => x.email === email)) {
        subs.push({ email, who: cleanWho(b.who), since: new Date().toISOString().slice(0, 10) });
        // ClickUp se traga descripciones que EMPIEZAN con "[" — el prefijo de texto lo evita
        await cu(`task/${SUBS_TASK_ID}`, "PUT", { description: SUBS_PREFIX + JSON.stringify(subs) });
      }
      return res.status(200).json({ ok: true });
    }

    if (role !== "edit") return res.status(403).json({ err: "Tu código es de solo lectura" });

    if (action === "create_task") {
      const lists = await domLists();
      const listId = lists[b.area];
      if (!listId) return res.status(400).json({ err: "Área inválida" });
      const name = String(b.name || "").trim().slice(0, 200);
      if (!name) return res.status(400).json({ err: "Falta el nombre" });
      const body = {
        name,
        description: `Creada por ${cleanWho(b.who)} desde el portal DOM`,
        priority: [1, 2, 3, 4].includes(Number(b.priority)) ? Number(b.priority) : 3,
      };
      if (b.due_date) { body.due_date = Number(b.due_date); body.due_date_time = false; }
      if (b.project) {
        const slug = slugify(b.project);
        if (slug) body.tags = [PROJECT_PREFIX + slug];
      }
      const t = await cu(`list/${listId}/task`, "POST", body);
      return res.status(200).json({ ok: true, id: t.id });
    }

    if (action === "update_task") {
      const t = await assertTaskInDom(b.task_id);
      const body = {};
      if (b.name !== undefined) {
        const name = String(b.name).trim().slice(0, 200);
        if (!name) return res.status(400).json({ err: "Nombre vacío" });
        body.name = name;
      }
      if (b.due_date !== undefined) { body.due_date = Number(b.due_date); body.due_date_time = false; }
      if (b.priority !== undefined) {
        if (![1, 2, 3, 4].includes(Number(b.priority))) return res.status(400).json({ err: "Prioridad inválida" });
        body.priority = Number(b.priority);
      }
      if (b.done === true) {
        const d = await cu(`list/${t.list.id}`);
        const s = (d.statuses || []).find((x) => x.type === "closed" || x.type === "done");
        body.status = s ? s.status : "complete";
      }
      if (!Object.keys(body).length) return res.status(400).json({ err: "Nada que actualizar" });
      await cu(`task/${t.id}`, "PUT", body);
      return res.status(200).json({ ok: true });
    }

    if (action === "set_project") {
      const t = await assertTaskInDom(b.task_id);
      for (const p of projectsOf(t)) {
        await cu(`task/${t.id}/tag/${encodeURIComponent(PROJECT_PREFIX + p)}`, "DELETE").catch(() => {});
      }
      if (b.project) {
        const slug = slugify(b.project);
        if (slug) await cu(`task/${t.id}/tag/${encodeURIComponent(PROJECT_PREFIX + slug)}`, "POST");
      }
      return res.status(200).json({ ok: true });
    }

    if (action === "create_project") {
      const slug = slugify(b.name);
      if (!slug) return res.status(400).json({ err: "Nombre de proyecto inválido" });
      await cu(`space/${SPACE_ID}/tag`, "POST", { tag: { name: PROJECT_PREFIX + slug, tag_fg: "#ffffff", tag_bg: "#7b68ee" } });
      return res.status(200).json({ ok: true, project: slug });
    }

    if (action === "add_comment") {
      const t = await assertTaskInDom(b.task_id);
      const text = String(b.text || "").trim().slice(0, 4000);
      if (!text) return res.status(400).json({ err: "Comentario vacío" });
      await cu(`task/${t.id}/comment`, "POST", { comment_text: `👤 ${cleanWho(b.who)} (DOM):\n${text}`, notify_all: false });
      return res.status(200).json({ ok: true });
    }

    if (action === "edit_comment" || action === "delete_comment") {
      const t = await assertTaskInDom(b.task_id);
      const c = await cu(`task/${t.id}/comment`);
      const target = (c.comments || []).find((x) => String(x.id) === String(b.comment_id));
      if (!target) return res.status(403).json({ err: "Ese avance no pertenece a esta tarea" });
      if (action === "delete_comment") {
        await cu(`comment/${target.id}`, "DELETE");
      } else {
        const text = String(b.text || "").trim().slice(0, 4000);
        if (!text) return res.status(400).json({ err: "Comentario vacío" });
        await cu(`comment/${target.id}`, "PUT", { comment_text: text });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ err: "Acción inválida" });
  } catch (e) {
    res.status(e.forbid ? 403 : 502).json({ err: String(e.message || e) });
  }
}
