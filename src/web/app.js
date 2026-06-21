"use strict";

const state = {
  path: "",
  entries: [],            // the entries on the current page (server-sorted)
  sort: { key: "name", dir: "asc" },
  selected: new Set(),
  offset: 0,              // index of the first entry on the current page
  limit: 200,             // page size (kept in sync with what the server applies)
  total: 0,               // total entries in the folder (after filtering), across all pages
  q: "",                  // active name filter (server-side substring match)
};

const els = {
  rows: document.getElementById("rows"),
  crumbs: document.getElementById("crumbs"),
  empty: document.getElementById("empty"),
  pager: document.getElementById("pager"),
  filterInput: document.getElementById("filterInput"),
  pageSize: document.getElementById("pageSize"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  uploadStatus: document.getElementById("uploadStatus"),
  toast: document.getElementById("toast"),
  bulkbar: document.getElementById("bulkbar"),
  selectAll: document.getElementById("selectAll"),
};

// ---------- helpers ----------
function fmtSize(n) {
  if (n === 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
}
function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function joinPath(dir, name) { return dir ? dir + "/" + name : name; }
function parentPath(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function extOf(name) { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : ""; }
function kindOf(e) { return e.is_dir ? "Folder" : (extOf(e.name) ? extOf(e.name).toUpperCase() : "File"); }

// Inline SVG icons (Feather-style, stroke = currentColor — no icon font needed).
const ICONS = {
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  folderPlus: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  move: '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
};

function icon(name) {
  return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
}

let toastTimer;
function toast(msg, isError) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("error", !!isError);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 3000);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) { location.href = "/login"; throw new Error("unauth"); }
  if (!res.ok) {
    let msg = "Request failed";
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

// ---------- rendering ----------
// Navigate into a folder (or refresh it): jumps to the first page and drops the
// selection, which doesn't carry across folders.
//
// When the path actually changes we push a browser-history entry so the back
// button walks back up the folder trail. Refreshes (rename/delete/upload, which
// reload the same folder) and back/forward navigation pass history:false so we
// don't pollute or fight the history stack.
async function load(path, { history = true } = {}) {
  path = path || "";
  const changed = path !== state.path;
  state.path = path;
  state.offset = 0;
  state.q = ""; // the filter is per-folder; reset it when navigating
  if (els.filterInput) els.filterInput.value = "";
  state.selected.clear();
  await fetchPage();
  if (history && changed) {
    const url = path ? "?path=" + encodeURIComponent(path) : location.pathname;
    window.history.pushState({ path }, "", url);
  }
}

// Back/forward button: re-load the folder recorded in the history entry without
// pushing a new one.
window.addEventListener("popstate", (ev) => {
  load((ev.state && ev.state.path) || "", { history: false });
});

// Fetch the current page (path + sort + offset/limit). Sorting and paging both
// happen server-side so a folder with tens of thousands of files only ever
// ships and renders one page at a time.
async function fetchPage() {
  const params = new URLSearchParams({
    path: state.path,
    sort: state.sort.key,
    dir: state.sort.dir,
    offset: String(state.offset),
    limit: String(state.limit),
  });
  if (state.q) params.set("q", state.q);
  let data;
  try {
    data = await api("/api/list?" + params.toString());
  } catch (e) { toast(e.message, true); return; }
  state.path = data.path;
  state.entries = data.entries;
  state.total = data.total;
  state.offset = data.offset; // server may clamp a stale offset
  state.limit = data.limit;
  renderCrumbs(state.path);
  renderRows();
}

function setSort(key) {
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
  } else {
    state.sort = { key, dir: "asc" };
  }
  state.offset = 0; // re-sorting changes which entries fall on the first page
  fetchPage();
}

function renderSortIndicators() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    const arrow = th.querySelector(".arrow");
    if (th.dataset.sort === state.sort.key) {
      th.classList.add("active");
      arrow.textContent = state.sort.dir === "asc" ? " ▲" : " ▼";
    } else {
      th.classList.remove("active");
      arrow.textContent = "";
    }
  });
}

function renderCrumbs(p) {
  els.crumbs.innerHTML = "";
  const home = document.createElement("a");
  home.textContent = "home";
  home.onclick = () => load("");
  els.crumbs.appendChild(home);
  if (!p) return;
  let acc = "";
  for (const part of p.split("/")) {
    acc = joinPath(acc, part);
    const sep = document.createElement("span");
    sep.className = "sep"; sep.textContent = "/";
    els.crumbs.appendChild(sep);
    const a = document.createElement("a");
    a.textContent = part;
    const target = acc;
    a.onclick = () => load(target);
    els.crumbs.appendChild(a);
  }
  els.crumbs.lastChild.className = "current";
  els.crumbs.lastChild.onclick = null;
}

function renderRows() {
  els.rows.innerHTML = "";
  els.empty.hidden = state.total > 0;
  els.empty.textContent = state.q
    ? `No items match “${state.q}”.`
    : "This folder is empty.";
  for (const e of state.entries) {
    els.rows.appendChild(rowFor(e));
  }
  renderSortIndicators();
  renderBulkBar();
  renderPager();
  updateSelectAll();
}

// Windowed page list with ellipsis gaps (null), mirroring reelcoral:
//   near start: 1 2 3 4 5 … N   near end: 1 … N-4..N   middle: 1 … c-1 c c+1 … N
function pageNumbers(current, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages = [1];
  if (current <= 4) {
    for (let i = 2; i <= 5; i++) pages.push(i);
    pages.push(null, totalPages);
  } else if (current >= totalPages - 3) {
    pages.push(null);
    for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(null, current - 1, current, current + 1, null, totalPages);
  }
  return pages;
}

function gotoPage(p) {
  const totalPages = Math.max(1, Math.ceil(state.total / state.limit));
  const clamped = Math.min(Math.max(1, p), totalPages);
  state.offset = (clamped - 1) * state.limit;
  fetchPage();
}

function renderPager() {
  if (!els.pager) return;
  els.pager.innerHTML = "";
  const totalPages = Math.ceil(state.total / state.limit);
  if (totalPages <= 1) { els.pager.hidden = true; return; }
  els.pager.hidden = false;

  const page = Math.floor(state.offset / state.limit) + 1;

  const navBtn = (label, target, disabled, title) => {
    const b = document.createElement("button");
    b.className = "page-btn nav";
    b.innerHTML = label;
    b.title = title;
    b.disabled = disabled;
    if (!disabled) b.onclick = () => gotoPage(target);
    return b;
  };

  els.pager.append(
    navBtn("&laquo;", 1, page <= 1, "First page"),
    navBtn("&lsaquo;", page - 1, page <= 1, "Previous page"),
  );

  for (const p of pageNumbers(page, totalPages)) {
    if (p === null) {
      const span = document.createElement("span");
      span.className = "page-ellipsis";
      span.textContent = "…";
      els.pager.appendChild(span);
    } else {
      const b = document.createElement("button");
      b.className = "page-btn" + (p === page ? " active" : "");
      b.textContent = String(p);
      if (p !== page) b.onclick = () => gotoPage(p);
      els.pager.appendChild(b);
    }
  }

  els.pager.append(
    navBtn("&rsaquo;", page + 1, page >= totalPages, "Next page"),
    navBtn("&raquo;", totalPages, page >= totalPages, "Last page"),
  );

  // Jump-to-page box once there are enough pages to make scanning tedious.
  if (totalPages > 7) {
    const wrap = document.createElement("span");
    wrap.className = "page-jump";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = String(totalPages);
    input.placeholder = "#";
    const go = () => {
      const n = parseInt(input.value, 10);
      if (n >= 1 && n <= totalPages && n !== page) gotoPage(n);
      input.value = "";
    };
    input.onkeydown = (ev) => { if (ev.key === "Enter") go(); };
    const goBtn = document.createElement("button");
    goBtn.className = "page-btn nav";
    goBtn.textContent = "Go";
    goBtn.onclick = go;
    wrap.append(input, goBtn);
    els.pager.appendChild(wrap);
  }
}

function rowFor(e) {
  const full = joinPath(state.path, e.name);
  const tr = document.createElement("tr");
  tr.draggable = true;
  tr.className = "filerow" + (e.is_dir ? " dir-row" : "") + (state.selected.has(full) ? " selected" : "");
  tr.dataset.path = full;
  tr.dataset.dir = e.is_dir ? "1" : "";

  // selection checkbox (its own column)
  const checkTd = document.createElement("td");
  checkTd.className = "col-check cell-check";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.selected.has(full);
  cb.onclick = (ev) => ev.stopPropagation(); // don't trigger row navigation
  cb.onchange = () => toggleSelect(full, cb.checked, tr);
  checkTd.appendChild(cb);

  // Folders open when their row is tapped. Files do nothing on row-click —
  // use the row menu (Download / Rename / …). Clicks on the actions cell
  // (kebab/menu) are always excluded.
  if (e.is_dir) {
    tr.addEventListener("click", (ev) => {
      if (ev.target.closest(".row-actions")) return;
      load(full);
    });
  }

  // name cell
  const nameTd = document.createElement("td");
  const cell = document.createElement("div");
  cell.className = "name-cell" + (e.is_dir ? " dir" : "");
  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = e.is_dir ? "📁" : "📄";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = e.name;
  cell.append(icon, label);
  nameTd.appendChild(cell);

  const kindTd = document.createElement("td");
  kindTd.className = "muted-cell cell-kind";
  kindTd.textContent = kindOf(e);
  const sizeTd = document.createElement("td");
  sizeTd.className = "muted-cell cell-size";
  sizeTd.textContent = e.is_dir ? "—" : fmtSize(e.size);
  const modTd = document.createElement("td");
  modTd.className = "muted-cell cell-mod";
  modTd.textContent = fmtDate(e.mod_time);

  const actTd = document.createElement("td");
  actTd.className = "row-actions";
  actTd.appendChild(kebabFor(e, full));

  tr.append(checkTd, nameTd, kindTd, sizeTd, modTd, actTd);

  // drag to move
  tr.addEventListener("dragstart", (ev) => {
    ev.dataTransfer.setData("text/x-reelhook", full);
    ev.dataTransfer.effectAllowed = "move";
    tr.classList.add("dragging");
  });
  tr.addEventListener("dragend", () => tr.classList.remove("dragging"));

  if (e.is_dir) {
    tr.addEventListener("dragover", (ev) => {
      if (ev.dataTransfer.types.includes("text/x-reelhook")) { ev.preventDefault(); tr.classList.add("dir-target"); }
    });
    tr.addEventListener("dragleave", () => tr.classList.remove("dir-target"));
    tr.addEventListener("drop", (ev) => {
      const src = ev.dataTransfer.getData("text/x-reelhook");
      if (!src) return;
      ev.preventDefault(); ev.stopPropagation();
      tr.classList.remove("dir-target");
      if (src !== full) moveItem(src, full);
    });
  }
  return tr;
}

function kebabFor(e, full) {
  const wrap = document.createElement("span");
  const btn = document.createElement("button");
  btn.className = "kebab"; btn.textContent = "⋯";
  btn.onclick = (ev) => { ev.stopPropagation(); openMenu(wrap, e, full); };
  wrap.appendChild(btn);
  return wrap;
}

function closeMenus() { document.querySelectorAll(".menu").forEach((m) => m.remove()); }
document.addEventListener("click", closeMenus);

function openMenu(wrap, e, full) {
  closeMenus();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.onclick = (ev) => ev.stopPropagation();

  if (!e.is_dir) menu.appendChild(menuItem("Download", "download", () => downloadFile(full)));
  else menu.appendChild(menuItem("Download (zip)", "download", () => bulkDownload([full])));
  menu.appendChild(menuItem("Rename", "edit", () => renameItem(full, e.name)));
  menu.appendChild(menuItem("Move to…", "move", () => promptMove(full)));
  menu.appendChild(menuItem("Delete", "trash", () => deleteItem(full, e.name), true));
  wrap.appendChild(menu);
}

function menuItem(text, ic, fn, danger) {
  const b = document.createElement("button");
  b.innerHTML = icon(ic) + "<span>" + text + "</span>";
  if (danger) b.className = "danger";
  b.onclick = () => { closeMenus(); fn(); };
  return b;
}

// ---------- operations ----------
function downloadFile(full) {
  window.location.href = "/api/download?path=" + encodeURIComponent(full);
}

async function renameItem(full, current) {
  const name = prompt("Rename to:", current);
  if (!name || name === current) return;
  try {
    await api("/api/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: full, new_name: name }) });
    toast("Renamed"); load(state.path);
  } catch (e) { toast(e.message, true); }
}

async function deleteItem(full, name) {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    await api("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: full }) });
    toast("Deleted"); load(state.path);
  } catch (e) { toast(e.message, true); }
}

async function moveItem(src, dstDir) {
  try {
    await api("/api/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ src, dst: dstDir }) });
    toast("Moved"); load(state.path);
  } catch (e) { toast(e.message, true); }
}

function promptMove(full) {
  const dst = prompt("Move to folder (path relative to Home, blank for Home):", parentPath(full));
  if (dst === null) return;
  moveItem(full, dst.trim());
}

async function makeFolder() {
  const name = prompt("New folder name:");
  if (!name) return;
  try {
    await api("/api/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: state.path, name }) });
    toast("Folder created"); load(state.path);
  } catch (e) { toast(e.message, true); }
}

// ---------- selection & bulk actions ----------
function toggleSelect(full, checked, tr) {
  if (checked) state.selected.add(full); else state.selected.delete(full);
  if (tr) tr.classList.toggle("selected", checked);
  renderBulkBar();
  updateSelectAll();
}

// The header checkbox reflects only the current page; selection itself persists
// across pages (it's keyed by full path), so count how many on-page entries are
// selected rather than comparing against the whole selection set.
function updateSelectAll() {
  if (!els.selectAll) return;
  const pageCount = state.entries.length;
  let onPage = 0;
  for (const ent of state.entries) {
    if (state.selected.has(joinPath(state.path, ent.name))) onPage++;
  }
  els.selectAll.checked = pageCount > 0 && onPage === pageCount;
  els.selectAll.indeterminate = onPage > 0 && onPage < pageCount;
}

function renderBulkBar() {
  const n = state.selected.size;
  els.bulkbar.hidden = n === 0;
  if (n === 0) return;
  els.bulkbar.innerHTML = "";

  const label = document.createElement("span");
  label.className = "bulk-count";
  label.textContent = `${n} selected`;

  const actions = document.createElement("span");
  actions.className = "bulk-actions";
  actions.append(
    bulkBtn("Download", "download", () => bulkDownload([...state.selected])),
    bulkBtn("Move to…", "move", () => bulkMove([...state.selected])),
    bulkBtn("Delete", "trash", () => bulkDelete([...state.selected]), true),
    bulkBtn("Clear", "x", clearSelection, false, true),
  );
  els.bulkbar.append(label, actions);
}

function bulkBtn(text, ic, fn, danger, ghost) {
  const b = document.createElement("button");
  b.className = "btn" + (danger ? " danger-btn" : "") + (ghost ? " ghost" : "");
  b.innerHTML = icon(ic) + "<span>" + text + "</span>";
  b.onclick = fn;
  return b;
}

function clearSelection() {
  state.selected.clear();
  document.querySelectorAll("tr.filerow.selected").forEach((tr) => tr.classList.remove("selected"));
  document.querySelectorAll("#rows input[type=checkbox]").forEach((cb) => (cb.checked = false));
  renderBulkBar();
  updateSelectAll();
}

// Download via a hidden form POST so any number of paths fits (no URL limit)
// and the browser handles the save natively — works on mobile too.
function bulkDownload(paths) {
  if (!paths.length) return;
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/zip";
  form.style.display = "none";
  for (const p of paths) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "path";
    input.value = p;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  setTimeout(() => form.remove(), 2000);
}

async function bulkDelete(paths) {
  if (!confirm(`Delete ${paths.length} item(s)? This cannot be undone.`)) return;
  let ok = 0, fail = 0;
  for (const p of paths) {
    try {
      await api("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) });
      ok++;
    } catch (_) { fail++; }
  }
  toast(`Deleted ${ok}${fail ? `, ${fail} failed` : ""}`, fail > 0);
  load(state.path);
}

async function bulkMove(paths) {
  const dst = prompt(`Move ${paths.length} item(s) to folder (path relative to Home, blank for Home):`, state.path);
  if (dst === null) return;
  const target = dst.trim();
  let ok = 0, fail = 0;
  for (const p of paths) {
    try {
      await api("/api/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ src: p, dst: target }) });
      ok++;
    } catch (_) { fail++; }
  }
  toast(`Moved ${ok}${fail ? `, ${fail} failed` : ""}`, fail > 0);
  load(state.path);
}

// ---------- upload manager ----------
// Each file is uploaded as its own request so it can be tracked and canceled
// individually. Up to `max` run concurrently; the rest wait in the queue.
const uploadMgr = { items: [], active: 0, max: 3, seq: 0, collapsed: false };

function uploadFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  for (const f of files) {
    uploadMgr.items.push({
      id: ++uploadMgr.seq,
      file: f, name: f.name, size: f.size,
      loaded: 0, status: "queued", xhr: null, error: "",
      path: state.path, // capture destination at enqueue time
    });
  }
  uploadMgr.collapsed = false;
  renderUploadPanel();
  pumpUploads();
}

function pumpUploads() {
  while (uploadMgr.active < uploadMgr.max) {
    const next = uploadMgr.items.find((i) => i.status === "queued");
    if (!next) break;
    startUpload(next);
  }
  updateUploadHeader();
}

function startUpload(item) {
  item.status = "uploading";
  uploadMgr.active++;
  updateItemView(item);

  const form = new FormData();
  form.append("files", item.file, item.name);
  const xhr = new XMLHttpRequest();
  item.xhr = xhr;
  xhr.open("POST", "/api/upload?path=" + encodeURIComponent(item.path));

  xhr.upload.onprogress = (ev) => {
    if (ev.lengthComputable) { item.loaded = ev.loaded; updateItemView(item); updateUploadHeader(); }
  };
  xhr.onload = () => {
    uploadMgr.active--;
    if (xhr.status === 401) { location.href = "/login"; return; }
    if (xhr.status >= 200 && xhr.status < 300) {
      item.status = "done"; item.loaded = item.size;
      if (item.path === state.path) load(state.path); // refresh the view it landed in
    } else {
      item.status = "error";
      try { item.error = JSON.parse(xhr.responseText).error || ""; } catch (_) {}
    }
    item.xhr = null;
    updateItemView(item); pumpUploads();
  };
  xhr.onerror = () => {
    uploadMgr.active--;
    if (item.status !== "canceled") item.status = "error";
    item.xhr = null;
    updateItemView(item); pumpUploads();
  };
  xhr.onabort = () => {
    uploadMgr.active--;
    item.status = "canceled"; item.xhr = null;
    updateItemView(item); pumpUploads();
  };
  xhr.send(form);
}

function cancelItem(id) {
  const item = uploadMgr.items.find((i) => i.id === id);
  if (!item) return;
  if (item.status === "uploading" && item.xhr) item.xhr.abort();
  else if (item.status === "queued") { item.status = "canceled"; updateItemView(item); updateUploadHeader(); }
}

function cancelAll() {
  for (const i of uploadMgr.items) {
    if (i.status === "queued") i.status = "canceled";
    else if (i.status === "uploading" && i.xhr) i.xhr.abort();
  }
  renderUploadPanel();
}

function clearUploads() {
  // Drop finished entries; keep anything still queued/uploading.
  uploadMgr.items = uploadMgr.items.filter((i) => i.status === "queued" || i.status === "uploading");
  if (uploadMgr.items.length === 0) { els.uploadStatus.hidden = true; return; }
  renderUploadPanel();
}

function uploadCounts() {
  const c = { total: uploadMgr.items.length, done: 0, error: 0, canceled: 0, pending: 0, bytes: 0, loaded: 0 };
  for (const i of uploadMgr.items) {
    if (i.status === "done") c.done++;
    else if (i.status === "error") c.error++;
    else if (i.status === "canceled") c.canceled++;
    else { c.pending++; c.bytes += i.size; c.loaded += i.loaded; }
  }
  return c;
}

function renderUploadPanel() {
  if (uploadMgr.items.length === 0) { els.uploadStatus.hidden = true; return; }
  els.uploadStatus.hidden = false;
  els.uploadStatus.innerHTML = "";

  const head = document.createElement("div");
  head.className = "up-head";
  const title = document.createElement("span");
  title.className = "up-title";
  const actions = document.createElement("span");
  actions.className = "up-head-actions";

  const collapseBtn = document.createElement("button");
  collapseBtn.className = "up-iconbtn";
  collapseBtn.title = uploadMgr.collapsed ? "Expand" : "Minimize";
  collapseBtn.innerHTML = icon(uploadMgr.collapsed ? "square" : "minus");
  collapseBtn.onclick = () => { uploadMgr.collapsed = !uploadMgr.collapsed; renderUploadPanel(); };

  const cancelAllBtn = document.createElement("button");
  cancelAllBtn.className = "up-textbtn";
  cancelAllBtn.innerHTML = icon("x") + "<span>Cancel all</span>";
  cancelAllBtn.onclick = cancelAll;

  const clearBtn = document.createElement("button");
  clearBtn.className = "up-iconbtn";
  clearBtn.title = "Close";
  clearBtn.innerHTML = icon("x");
  clearBtn.onclick = clearUploads;

  actions.append(cancelAllBtn, collapseBtn, clearBtn);
  head.append(title, actions);
  els.uploadStatus.appendChild(head);

  const list = document.createElement("div");
  list.className = "up-list";
  if (uploadMgr.collapsed) list.style.display = "none";
  for (const item of uploadMgr.items) {
    list.appendChild(buildItemRow(item));
  }
  els.uploadStatus.appendChild(list);
  updateUploadHeader();
}

function buildItemRow(item) {
  const row = document.createElement("div");
  row.className = "up-item";
  row.dataset.id = String(item.id);

  const name = document.createElement("span");
  name.className = "up-name";
  name.textContent = item.name;
  name.title = item.name;

  const meta = document.createElement("div");
  meta.className = "up-meta";
  const bar = document.createElement("div");
  bar.className = "up-bar";
  const fill = document.createElement("div");
  bar.appendChild(fill);
  const stat = document.createElement("span");
  stat.className = "up-stat";
  const cancel = document.createElement("button");
  cancel.className = "up-cancel";
  cancel.title = "Cancel";
  cancel.innerHTML = icon("x");
  cancel.onclick = () => cancelItem(item.id);

  meta.append(bar, stat, cancel);
  row.append(name, meta);

  item._refs = { row, fill, stat, cancel };
  paintItem(item);
  return row;
}

function updateItemView(item) {
  if (item._refs) paintItem(item);
}

function paintItem(item) {
  const { row, fill, stat, cancel } = item._refs;
  row.classList.toggle("done", item.status === "done");
  row.classList.toggle("error", item.status === "error");
  row.classList.toggle("canceled", item.status === "canceled");

  const pct = item.size ? Math.round((item.loaded / item.size) * 100) : (item.status === "done" ? 100 : 0);
  fill.style.width = (item.status === "done" ? 100 : pct) + "%";

  if (item.status === "queued") stat.textContent = "Queued";
  else if (item.status === "uploading") stat.textContent = pct + "%";
  else if (item.status === "done") stat.textContent = "✓";
  else if (item.status === "canceled") stat.textContent = "Canceled";
  else stat.textContent = item.error ? "Failed: " + item.error : "Failed";

  const finished = item.status === "done" || item.status === "canceled" || item.status === "error";
  cancel.style.visibility = finished ? "hidden" : "visible";
}

function updateUploadHeader() {
  const title = els.uploadStatus.querySelector(".up-title");
  if (!title) return;
  const c = uploadCounts();
  if (c.pending > 0) {
    const overall = c.bytes ? Math.round((c.loaded / c.bytes) * 100) : 0;
    title.textContent = `Uploading ${c.done}/${c.total} · ${overall}%`;
  } else {
    const parts = [];
    if (c.done) parts.push(`${c.done} uploaded`);
    if (c.error) parts.push(`${c.error} failed`);
    if (c.canceled) parts.push(`${c.canceled} canceled`);
    title.textContent = parts.join(" · ") || "Uploads";
  }
  const cancelAllBtn = els.uploadStatus.querySelector(".up-textbtn");
  if (cancelAllBtn) cancelAllBtn.style.display = c.pending > 0 ? "" : "none";
}

// ---------- drag-drop upload ----------
let dragDepth = 0;
els.dropZone.addEventListener("dragenter", (ev) => {
  if (ev.dataTransfer.types.includes("Files")) { dragDepth++; els.dropZone.classList.add("dragover"); }
});
els.dropZone.addEventListener("dragover", (ev) => { if (ev.dataTransfer.types.includes("Files")) ev.preventDefault(); });
els.dropZone.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; els.dropZone.classList.remove("dragover"); } });
els.dropZone.addEventListener("drop", (ev) => {
  if (!ev.dataTransfer.types.includes("Files")) return;
  ev.preventDefault();
  dragDepth = 0; els.dropZone.classList.remove("dragover");
  if (ev.dataTransfer.files.length) uploadFiles(ev.dataTransfer.files);
});

// ---------- theme ----------
// The active theme lives on <html data-theme>. An early inline script in the
// page applies any saved choice before paint; here we just provide the toggle
// and keep the button icon in sync (sun while dark, moon while light).
const THEME_KEY = "reelhook.theme";
const themeBtn = document.getElementById("themeBtn");
function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const ic = document.getElementById("themeIcon");
  if (ic) ic.innerHTML = theme === "dark" ? ICONS.sun : ICONS.moon;
  if (themeBtn) {
    const next = theme === "dark" ? "light" : "dark";
    themeBtn.title = `Switch to ${next} mode`;
    themeBtn.setAttribute("aria-label", themeBtn.title);
  }
}
if (themeBtn) {
  themeBtn.onclick = () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    applyTheme(next);
  };
}
applyTheme(currentTheme());

// ---------- wiring ----------
document.getElementById("uploadBtn").onclick = () => els.fileInput.click();
document.getElementById("newFolderBtn").onclick = makeFolder;
els.fileInput.onchange = () => { uploadFiles(els.fileInput.files); els.fileInput.value = ""; };

document.querySelectorAll("th.sortable").forEach((th) => {
  th.addEventListener("click", () => setSort(th.dataset.sort));
});

// Debounce filter input so we re-query the server at most ~every 200ms while
// typing rather than on every keystroke.
let filterTimer;
els.filterInput.addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    const v = els.filterInput.value.trim();
    if (v === state.q) return;
    state.q = v;
    state.offset = 0; // new filter → back to the first page of results
    fetchPage();
  }, 200);
});
// Esc clears the filter immediately.
els.filterInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && els.filterInput.value) {
    clearTimeout(filterTimer);
    els.filterInput.value = "";
    state.q = "";
    state.offset = 0;
    fetchPage();
  }
});

els.selectAll.addEventListener("change", (e) => {
  const checked = e.target.checked;
  // Toggle only the current page; entries selected on other pages stay as-is.
  for (const ent of state.entries) {
    const full = joinPath(state.path, ent.name);
    if (checked) state.selected.add(full); else state.selected.delete(full);
  }
  renderRows();
});

// Page size: remember the choice across sessions and apply it before the first
// load. Only values offered by the <select> are accepted (the server caps at
// 1000 regardless).
const PAGE_SIZE_KEY = "reelhook.pageSize";
function pageSizeOptions() {
  return [...els.pageSize.options].map((o) => Number(o.value));
}
(function initPageSize() {
  const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
  if (pageSizeOptions().includes(saved)) state.limit = saved;
  els.pageSize.value = String(state.limit);
})();
els.pageSize.addEventListener("change", () => {
  state.limit = Number(els.pageSize.value);
  try { localStorage.setItem(PAGE_SIZE_KEY, String(state.limit)); } catch (_) {}
  state.offset = 0; // a different page size invalidates the current offset
  fetchPage();
});

// Honor a ?path= deep link on first load, and seed a baseline history entry so
// the very first popstate has a path to return to.
const initialPath = new URLSearchParams(location.search).get("path") || "";
window.history.replaceState({ path: initialPath }, "", location.href);
load(initialPath, { history: false });
