// Portal cliente DOM: endpoint de SOLO LECTURA limitado a la carpeta de DOM.
// El cliente entra con un código (env DOM_ACCESS_CODE); las llamadas a ClickUp
// salen con el token del servidor (CLICKUP_TOKEN) y solo exponen datos de DOM.
const DOM_FOLDER_ID = "901318180640";

function listKeyFor(listName) {
  const n = listName.toLowerCase();
  if (n.includes("paid")) return "paid";
  if (n.includes("dise")) return "disenio";
  if (n.includes("estrategia")) return "estrategia";
  if (n.includes("admin")) return "admin";
  if (n.includes("desarrollo") || n.includes("web")) return "desweb";
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Access-Code");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ err: "Solo lectura" });

  const code = process.env.DOM_ACCESS_CODE;
  if (!code) return res.status(503).json({ err: "El acceso de cliente no está configurado (falta DOM_ACCESS_CODE en Vercel)" });
  if ((req.headers["x-access-code"] || "") !== code) return res.status(401).json({ err: "Código de acceso incorrecto" });

  const token = process.env.CLICKUP_TOKEN;
  if (!token) return res.status(503).json({ err: "Falta CLICKUP_TOKEN en Vercel" });

  const cu = async (path) => {
    const r = await fetch(`https://api.clickup.com/api/v2/${path}`, { headers: { Authorization: token } });
    if (!r.ok) throw new Error(`ClickUp ${r.status}`);
    return r.json();
  };

  try {
    const action = req.query.action;

    if (action === "board") {
      const folder = await cu(`folder/${DOM_FOLDER_ID}`);
      const lists = {};
      for (const l of folder.lists || []) {
        const key = listKeyFor(l.name);
        if (key && !lists[key]) lists[key] = l.id;
      }
      const area = req.query.area;
      if (!lists[area]) return res.status(200).json({ areas: Object.keys(lists), tasks: [] });
      const d = await cu(`list/${lists[area]}/task`);
      // Solo los campos que el cliente necesita ver — sin URLs internas ni correos
      const tasks = (d.tasks || []).map((t) => ({
        id: t.id,
        name: t.name,
        status: { status: t.status?.status || "", color: t.status?.color || "#c3c7d0" },
        due_date: t.due_date || null,
        assignees: (t.assignees || []).map((a) => ({ username: a.username || "", initials: a.initials || "", color: a.color || "" })),
      }));
      return res.status(200).json({ areas: Object.keys(lists), tasks });
    }

    if (action === "comments") {
      const tid = String(req.query.task_id || "");
      if (!/^[a-z0-9]+$/i.test(tid)) return res.status(400).json({ err: "task_id inválido" });
      const t = await cu(`task/${tid}`);
      if (String(t.folder?.id) !== DOM_FOLDER_ID) return res.status(403).json({ err: "Esa tarea no es de DOM" });
      const c = await cu(`task/${tid}/comment`);
      const comments = (c.comments || [])
        .map((x) => ({ user: x.user?.username || "", date: x.date, text: x.comment_text || "" }))
        .sort((a, b) => Number(a.date) - Number(b.date));
      return res.status(200).json({ comments });
    }

    return res.status(400).json({ err: "Acción inválida" });
  } catch (e) {
    res.status(502).json({ err: String(e.message || e) });
  }
}
