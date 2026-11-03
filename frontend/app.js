"use strict";

// ------------------------------------------------------------------ state --
const store = {
  get token() { try { return localStorage.getItem("pi_token"); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem("pi_token", v) : localStorage.removeItem("pi_token"); } catch {} },
  user: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");

// -------------------------------------------------------------------- api --
async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (store.token) headers.Authorization = `Bearer ${store.token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && store.token) {
    signOut();
    throw new Error(data.error || "Please sign in again");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- helpers --
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const money = (cents) => (cents ? `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}` : "Volunteer");
const fmtDate = (d) => d ? new Date(d + (d.length === 10 ? "T12:00:00" : "")).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const kb = (n) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

function mount(id) {
  view.replaceChildren($(`#${id}`).content.cloneNode(true));
}

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = !msg;
}

function taskCard(t) {
  const a = document.createElement("a");
  a.className = "card task";
  a.href = `#/task/${t.id}`;
  a.innerHTML = `
    <div class="task-top"><h2>${esc(t.title)}</h2><span class="reward">${money(t.reward_cents)}</span></div>
    ${t.description ? `<p>${esc(t.description)}</p>` : ""}
    <div class="meta">
      <span class="badge ${t.status}">${t.status}</span>
      ${t.location ? `<span>📍 ${esc(t.location)}</span>` : ""}
      ${t.due_date ? `<span>📅 ${fmtDate(t.due_date)}</span>` : ""}
      ${t.attachment_count ? `<span>📎 ${t.attachment_count}</span>` : ""}
      <span>by ${esc(t.poster.name)} · ${ago(t.created_at)}</span>
    </div>`;
  return a;
}

function renderList(el, tasks, emptyMsg) {
  el.replaceChildren();
  if (!tasks.length) {
    el.innerHTML = `<div class="empty">${emptyMsg}</div>`;
    return;
  }
  tasks.forEach((t) => el.append(taskCard(t)));
}

function skeletons(el) {
  el.innerHTML = '<div class="card skeleton"></div>'.repeat(3);
}

// ------------------------------------------------------------------- auth --
function signOut() {
  store.token = null;
  store.user = null;
  updateChrome();
  location.hash = "#/";
}

function updateChrome(route) {
  const signedIn = !!store.user;
  $("#nav").hidden = !signedIn;
  $("#who").hidden = !signedIn;
  $("#who-name").textContent = signedIn ? store.user.name : "";
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
}

function renderAuth() {
  mount("tpl-auth");
  const form = $("#auth-form");
  let mode = "login";
  const setMode = (m) => {
    mode = m;
    form.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.mode === m));
    $(".only-register", form).hidden = m !== "register";
    form.elements.password.autocomplete = m === "register" ? "new-password" : "current-password";
    $("#auth-submit").textContent = m === "register" ? "Create account" : "Sign in";
    showError($("#auth-error"), "");
  };
  form.querySelectorAll("[role=tab]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#auth-submit");
    btn.disabled = true;
    try {
      const body = { email: form.elements.email.value, password: form.elements.password.value };
      if (mode === "register") body.name = form.elements.name.value;
      const { token, user } = await api(`/auth/${mode}`, { method: "POST", body });
      store.token = token;
      store.user = user;
      if (location.hash === "#/browse") route();
      else location.hash = "#/browse";
    } catch (err) {
      showError($("#auth-error"), err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

// ----------------------------------------------------------------- browse --
async function renderBrowse() {
  mount("tpl-browse");
  const list = $("#list");
  const load = async (q = "") => {
    skeletons(list);
    try {
      const { tasks } = await api(`/tasks${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      renderList(list, tasks, q ? "No open tasks match that search." : 'No open tasks right now. <a href="#/post">Post one?</a>');
    } catch (err) {
      list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  };
  let timer;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => load(e.target.value.trim()), 250);
  });
  $("#search").addEventListener("submit", (e) => e.preventDefault());
  load();
}

// ------------------------------------------------------------------- post --
async function uploadFiles(taskId, files) {
  let failed = 0;
  for (const file of files) {
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("too big");
      const { attachment_id, upload } = await api(`/tasks/${taskId}/attachments`, {
        method: "POST",
        body: { filename: file.name, content_type: file.type || "application/octet-stream", size: file.size },
      });
      const fd = new FormData();
      Object.entries(upload.fields).forEach(([k, v]) => fd.append(k, v));
      fd.append("file", file);
      const res = await fetch(upload.url, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`S3 ${res.status}`);
      await api(`/attachments/${attachment_id}/confirm`, { method: "POST", body: {} });
    } catch {
      failed++;
    }
  }
  return failed;
}

function renderPost() {
  mount("tpl-post");
  const form = $("#post-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Posting…";
    showError($("#post-error"), "");
    try {
      const { task } = await api("/tasks", {
        method: "POST",
        body: {
          title: form.elements.title.value,
          description: form.elements.description.value,
          reward: form.elements.reward.value === "" ? 0 : Number(form.elements.reward.value),
          due_date: form.elements.due_date.value || null,
          location: form.elements.location.value,
        },
      });
      const files = [...form.elements.files.files];
      if (files.length) {
        btn.textContent = "Uploading files…";
        const failed = await uploadFiles(task.id, files);
        if (failed) toast(`${failed} file(s) couldn't be uploaded`);
      }
      toast("Task posted");
      location.hash = `#/task/${task.id}`;
    } catch (err) {
      showError($("#post-error"), err.message);
      btn.disabled = false;
      btn.textContent = "Post task";
    }
  });
}

// ------------------------------------------------------------------- mine --
async function renderMine() {
  mount("tpl-mine");
  const list = $("#list");
  skeletons(list);
  let data;
  const show = (tab) => {
    document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab));
    if (!data) return;
    renderList(list, data[tab], tab === "posted"
      ? 'You haven\'t posted anything yet. <a href="#/post">Post a task</a>'
      : 'You haven\'t accepted any tasks yet. <a href="#/browse">Browse open tasks</a>');
  };
  let current = "posted";
  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => show((current = b.dataset.tab))));
  try {
    data = await api("/tasks/mine");
    show(current);
  } catch (err) {
    list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

// ----------------------------------------------------------------- detail --
async function renderDetail(id) {
  mount("tpl-detail");
  const box = $("#detail");
  box.innerHTML = '<div class="skeleton" style="height:220px;border-radius:10px"></div>';
  $("#back").addEventListener("click", (e) => {
    if (history.length > 1) { e.preventDefault(); history.back(); }
  });

  let task;
  try {
    ({ task } = await api(`/tasks/${encodeURIComponent(id)}`));
  } catch (err) {
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }

  const me = store.user.id;
  const isPoster = task.poster.id === me;
  const isAccepter = task.accepter && task.accepter.id === me;

  const actions = [];
  let note = "";
  if (task.status === "open" && !isPoster) actions.push(`<button class="primary" data-act="accept">Accept this task</button>`);
  if (task.status === "open" && isPoster) {
    note = "Waiting for someone to accept.";
    actions.push(`<button class="danger" data-act="cancel">Cancel task</button>`);
  }
  if (task.status === "accepted" && isPoster) {
    note = `${esc(task.accepter.name)} is on it. Mark it complete once it's done.`;
    actions.push(`<button class="primary" data-act="complete">Mark complete</button>`);
  }
  if (task.status === "accepted" && isAccepter) {
    note = `You accepted this ${ago(task.accepted_at)}. ${esc(task.poster.name)} will mark it complete when it's done.`;
    actions.push(`<button class="secondary" data-act="release">Drop this task</button>`);
  }
  if (task.status === "accepted" && !isPoster && !isAccepter) note = "Someone else has already accepted this task.";
  if (task.status === "completed") note = `Completed ${fmtDate(task.completed_at)}${task.accepter ? ` by ${esc(task.accepter.name)}` : ""}.`;
  if (task.status === "cancelled") note = "The poster cancelled this task.";

  box.innerHTML = `
    <div class="task-top"><h1>${esc(task.title)}</h1><span class="badge ${task.status}">${task.status}</span></div>
    <dl class="facts">
      <div><dt>Reward</dt><dd>${money(task.reward_cents)}</dd></div>
      <div><dt>Due</dt><dd>${task.due_date ? fmtDate(task.due_date) : "Flexible"}</dd></div>
      <div><dt>Location</dt><dd>${esc(task.location || "—")}</dd></div>
      <div><dt>Posted by</dt><dd>${isPoster ? "You" : esc(task.poster.name)}</dd></div>
    </dl>
    ${task.description ? `<p class="desc">${esc(task.description)}</p>` : ""}
    ${task.attachments.length ? `<div><h3>Files</h3><ul class="files">${task.attachments.map((f) => `
      <li><button class="link" data-file="${f.id}">📎 ${esc(f.filename)}</button>
          <span class="meta">${kb(f.size_bytes)}${isPoster ? ` · <button class="link" data-remove="${f.id}">Remove</button>` : ""}</span></li>`).join("")}</ul></div>` : ""}
    ${note ? `<p class="note">${note}</p>` : ""}
    ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
  `;

  box.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
    const act = b.dataset.act;
    if (act === "cancel" && !confirm("Cancel this task? Nobody will be able to accept it.")) return;
    b.disabled = true;
    try {
      await api(`/tasks/${task.id}/${act}`, { method: "POST", body: {} });
      toast({ accept: "Task accepted — it's yours", release: "You dropped the task", complete: "Marked complete", cancel: "Task cancelled" }[act]);
      renderDetail(task.id);
    } catch (err) {
      toast(err.message);
      b.disabled = false;
    }
  }));
  box.querySelectorAll("[data-file]").forEach((b) => b.addEventListener("click", async () => {
    try {
      const { url } = await api(`/attachments/${b.dataset.file}/download`);
      location.href = url;
    } catch (err) {
      toast(err.message);
    }
  }));
  box.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Remove this file?")) return;
    try {
      await api(`/attachments/${b.dataset.remove}`, { method: "DELETE" });
      renderDetail(task.id);
    } catch (err) {
      toast(err.message);
    }
  }));
}

// ----------------------------------------------------------------- router --
async function route() {
  const [, name = "", arg] = location.hash.split("/");
  if (!store.user && store.token) {
    try {
      store.user = (await api("/me")).user;
    } catch {
      store.token = null;
    }
  }
  if (!store.user) {
    updateChrome();
    return renderAuth();
  }
  const r = name || "browse";
  updateChrome(r);
  window.scrollTo(0, 0);
  if (r === "post") return renderPost();
  if (r === "mine") return renderMine();
  if (r === "task" && arg) return renderDetail(arg);
  return renderBrowse();
}

$("#signout").addEventListener("click", signOut);
window.addEventListener("hashchange", route);
route();
