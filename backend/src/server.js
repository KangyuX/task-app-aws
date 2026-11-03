import crypto from "node:crypto";
import express from "express";
import { migrate, query } from "./db.js";
import { checkPassword, hashPassword, issueToken, publicUser, requireUser } from "./auth.js";
import { MAX_UPLOAD_BYTES, deleteObject, downloadUrl, objectSize, uploadForm } from "./files.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "64kb" }));

// Elastic Beanstalk's nginx health check hits "/" on the instance.
app.get("/", (_req, res) => res.type("text").send("ok"));
app.get("/api/health", (_req, res) => {
  query("SELECT 1").then(
    () => res.json({ ok: true }),
    () => res.status(503).json({ ok: false }),
  );
});

// Only CloudFront knows the origin secret; anything else hitting the instance is refused.
const originSecret = process.env.ORIGIN_SECRET;
app.use("/api", (req, res, next) => {
  if (!originSecret) return next();
  const got = Buffer.from(req.get("x-origin-secret") || "");
  const want = Buffer.from(originSecret);
  if (got.length === want.length && crypto.timingSafeEqual(got, want)) return next();
  res.status(403).json({ error: "Forbidden" });
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const str = (v, max, field, { required = false } = {}) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s;
};

const idParam = (v) => {
  if (!/^\d{1,15}$/.test(v)) throw new HttpError(404, "Task not found");
  return v;
};

// ---------------------------------------------------------------- auth ----
app.post("/api/auth/register", wrap(async (req, res) => {
  const email = str(req.body.email, 254, "Email", { required: true }).toLowerCase();
  const name = str(req.body.name, 80, "Name", { required: true });
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email");
  if (password.length < 8 || password.length > 200) throw new HttpError(400, "Password must be at least 8 characters");
  const hash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING id, email, name`,
    [email, name, hash],
  );
  if (!rows[0]) throw new HttpError(409, "An account with that email already exists");
  res.status(201).json({ token: issueToken(rows[0]), user: publicUser(rows[0]) });
}));

app.post("/api/auth/login", wrap(async (req, res) => {
  const email = str(req.body.email, 254, "Email").toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const { rows } = await query("SELECT id, email, name, password_hash FROM users WHERE email = $1", [email]);
  const ok = rows[0] && (await checkPassword(password, rows[0].password_hash));
  if (!ok) throw new HttpError(401, "Wrong email or password");
  res.json({ token: issueToken(rows[0]), user: publicUser(rows[0]) });
}));

app.get("/api/me", wrap(requireUser), (req, res) => res.json({ user: req.user }));

// --------------------------------------------------------------- tasks ----
const TASK_SELECT = `
  SELECT t.id, t.title, t.description, t.reward_cents, t.location, t.due_date, t.status,
         t.created_at, t.accepted_at, t.completed_at,
         p.id AS poster_id, p.name AS poster_name,
         a.id AS accepter_id, a.name AS accepter_name,
         (SELECT count(*) FROM attachments x WHERE x.task_id = t.id AND x.uploaded)::int AS attachment_count
  FROM tasks t
  JOIN users p ON p.id = t.poster_id
  LEFT JOIN users a ON a.id = t.accepter_id`;

const shape = (r) => ({
  id: Number(r.id),
  title: r.title,
  description: r.description,
  reward_cents: r.reward_cents,
  location: r.location,
  due_date: r.due_date,
  status: r.status,
  created_at: r.created_at,
  accepted_at: r.accepted_at,
  completed_at: r.completed_at,
  poster: { id: Number(r.poster_id), name: r.poster_name },
  accepter: r.accepter_id ? { id: Number(r.accepter_id), name: r.accepter_name } : null,
  attachment_count: r.attachment_count,
});

app.use("/api/tasks", wrap(requireUser));
app.use("/api/attachments", wrap(requireUser));

// Open tasks posted by other people.
app.get("/api/tasks", wrap(async (req, res) => {
  const q = str(req.query.q, 100, "Search");
  const params = [req.user.id];
  let where = "t.status = 'open' AND t.poster_id <> $1";
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    where += ` AND (t.title ILIKE $2 OR t.description ILIKE $2 OR t.location ILIKE $2)`;
  }
  const { rows } = await query(`${TASK_SELECT} WHERE ${where} ORDER BY t.created_at DESC LIMIT 200`, params);
  res.json({ tasks: rows.map(shape) });
}));

app.get("/api/tasks/mine", wrap(async (req, res) => {
  const [posted, accepted] = await Promise.all([
    query(`${TASK_SELECT} WHERE t.poster_id = $1 ORDER BY t.created_at DESC`, [req.user.id]),
    query(`${TASK_SELECT} WHERE t.accepter_id = $1 ORDER BY t.accepted_at DESC`, [req.user.id]),
  ]);
  res.json({ posted: posted.rows.map(shape), accepted: accepted.rows.map(shape) });
}));

app.post("/api/tasks", wrap(async (req, res) => {
  const title = str(req.body.title, 120, "Title", { required: true });
  const description = str(req.body.description, 4000, "Description");
  const location = str(req.body.location, 120, "Location");
  const reward = Number(req.body.reward ?? 0);
  if (!Number.isFinite(reward) || reward < 0 || reward > 100000) throw new HttpError(400, "Reward must be between 0 and 100,000");
  let due = req.body.due_date || null;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new HttpError(400, "Due date must be YYYY-MM-DD");
  const { rows } = await query(
    `INSERT INTO tasks (title, description, reward_cents, location, due_date, poster_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [title, description, Math.round(reward * 100), location, due, req.user.id],
  );
  const created = await query(`${TASK_SELECT} WHERE t.id = $1`, [rows[0].id]);
  res.status(201).json({ task: shape(created.rows[0]) });
}));

async function loadTask(id) {
  const { rows } = await query(`${TASK_SELECT} WHERE t.id = $1`, [idParam(id)]);
  if (!rows[0]) throw new HttpError(404, "Task not found");
  return shape(rows[0]);
}

app.get("/api/tasks/:id", wrap(async (req, res) => {
  const task = await loadTask(req.params.id);
  const { rows } = await query(
    `SELECT id, filename, content_type, size_bytes, created_at FROM attachments
     WHERE task_id = $1 AND uploaded ORDER BY created_at`,
    [task.id],
  );
  task.attachments = rows.map((r) => ({ ...r, id: Number(r.id) }));
  res.json({ task });
}));

// Status changes are single conditional UPDATEs, so two people can't accept the same task.
async function transition(req, res, sql, failMessage) {
  const id = idParam(req.params.id);
  const { rowCount } = await query(sql, [id, req.user.id]);
  if (!rowCount) {
    await loadTask(id); // 404 if it doesn't exist
    throw new HttpError(409, failMessage);
  }
  res.json({ task: await loadTask(id) });
}

app.post("/api/tasks/:id/accept", wrap((req, res) => transition(req, res,
  `UPDATE tasks SET status = 'accepted', accepter_id = $2, accepted_at = now()
   WHERE id = $1 AND status = 'open' AND poster_id <> $2`,
  "This task is no longer open (or it's your own task)")));

app.post("/api/tasks/:id/release", wrap((req, res) => transition(req, res,
  `UPDATE tasks SET status = 'open', accepter_id = NULL, accepted_at = NULL
   WHERE id = $1 AND status = 'accepted' AND accepter_id = $2`,
  "Only the person who accepted this task can drop it")));

app.post("/api/tasks/:id/complete", wrap((req, res) => transition(req, res,
  `UPDATE tasks SET status = 'completed', completed_at = now()
   WHERE id = $1 AND status = 'accepted' AND poster_id = $2`,
  "Only the poster can mark an accepted task complete")));

app.post("/api/tasks/:id/cancel", wrap((req, res) => transition(req, res,
  `UPDATE tasks SET status = 'cancelled'
   WHERE id = $1 AND status = 'open' AND poster_id = $2`,
  "Only the poster can cancel, and only while the task is open")));

// --------------------------------------------------------- attachments ----
// Step 1: poster asks for a presigned POST; the browser uploads straight to S3.
app.post("/api/tasks/:id/attachments", wrap(async (req, res) => {
  const task = await loadTask(req.params.id);
  if (task.poster.id !== req.user.id) throw new HttpError(403, "Only the poster can attach files");
  const filename = str(req.body.filename, 200, "Filename", { required: true });
  const contentType = str(req.body.content_type, 100, "Content type") || "application/octet-stream";
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) throw new HttpError(400, "Unsupported content type");
  const size = Number(req.body.size);
  if (!Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) throw new HttpError(400, "Files must be 10 MB or smaller");
  const { rows: [{ n }] } = await query("SELECT count(*)::int AS n FROM attachments WHERE task_id = $1 AND uploaded", [task.id]);
  if (n >= 10) throw new HttpError(400, "A task can have at most 10 files");

  const key = `attachments/${task.id}/${crypto.randomUUID()}`;
  const { rows } = await query(
    `INSERT INTO attachments (task_id, s3_key, filename, content_type, size_bytes, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [task.id, key, filename, contentType, size, req.user.id],
  );
  const form = await uploadForm(key, contentType);
  res.status(201).json({ attachment_id: Number(rows[0].id), upload: form });
}));

// Step 2: confirm once S3 has the object.
app.post("/api/attachments/:id/confirm", wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const { rows } = await query("SELECT * FROM attachments WHERE id = $1 AND uploaded_by = $2", [id, req.user.id]);
  if (!rows[0]) throw new HttpError(404, "Attachment not found");
  const size = await objectSize(rows[0].s3_key);
  if (size == null) throw new HttpError(409, "Upload not found in storage yet");
  await query("UPDATE attachments SET uploaded = true, size_bytes = $2 WHERE id = $1", [id, size]);
  res.json({ ok: true });
}));

app.get("/api/attachments/:id/download", wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const { rows } = await query("SELECT s3_key, filename FROM attachments WHERE id = $1 AND uploaded", [id]);
  if (!rows[0]) throw new HttpError(404, "Attachment not found");
  res.json({ url: await downloadUrl(rows[0].s3_key, rows[0].filename) });
}));

app.delete("/api/attachments/:id", wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const { rows } = await query(
    `DELETE FROM attachments a USING tasks t
     WHERE a.id = $1 AND a.task_id = t.id AND t.poster_id = $2 RETURNING a.s3_key`,
    [id, req.user.id],
  );
  if (!rows[0]) throw new HttpError(404, "Attachment not found");
  await deleteObject(rows[0].s3_key);
  res.json({ ok: true });
}));

// -------------------------------------------------------------- errors ----
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

const port = Number(process.env.PORT || 8080);

async function start() {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate();
      break;
    } catch (err) {
      console.error(`Database not ready (attempt ${attempt}): ${err.message}`);
      if (attempt >= 10) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  app.listen(port, () => console.log(`Pitch In API listening on ${port}`));
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
