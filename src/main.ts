import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import "./style.css";

type Item = { id: string; title: string; kind: "app" | "url" | "document"; target: string; icon?: string };
type Store = { items: Item[]; background: string | null };
type Service = { id: string; slug: string; name: string; icon: string; website: string; enhanced: boolean; tileBackground: "light" | "dark" };
type ServiceCatalog = { source: string; importedAt: string; count: number; services: Service[] };
type SystemStats = { cpuUsage: number; cpuName: string; memoryUsed: number; memoryTotal: number; swapUsed: number; swapTotal: number; diskUsed: number; diskTotal: number; gpu: { name: string; usage: number | null; usedMemory: number | null; totalMemory: number | null } | null; network: { interface: string; ip: string; mac: string; receivedPerSecond: number; transmittedPerSecond: number; totalReceived: number; totalTransmitted: number } | null; operatingSystem: string };

const glyphs: Record<string, string> = {
  globe: "◉", folder: "▰", code: "⌘", mail: "✉", chart: "▥", music: "♫", video: "▷", book: "▤",
  terminal: "›_", camera: "◉", cloud: "☁", star: "✦", heart: "♥", bolt: "ϟ", box: "▣", link: "↗",
};
let store: Store = { items: [], background: null };
let services: Service[] = [];
let menuItem: Item | null = null;
let contextPosition = { x: 0, y: 0 };
let toastTimer = 0;
let draggedItemId: string | null = null;
let pendingInsertIndex: number | null = null;
let pointerDrag: { id: string; pointerId: number; startX: number; startY: number; active: boolean; element: HTMLButtonElement } | null = null;
let suppressClickUntil = 0;
const histories = { cpu: [] as number[], memory: [] as number[], gpu: [] as number[], disk: [] as number[], download: [] as number[], upload: [] as number[] };
let statsTimer = 0;

const app = document.querySelector<HTMLDivElement>("#app")!;
const safe = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const iconFor = (item: Item) => item.icon?.startsWith("data:") || item.icon?.startsWith("/service-icons/") ? `<img src="${safe(item.icon)}" alt="" />` : `<span>${glyphs[item.icon || (item.kind === "url" ? "globe" : item.kind === "document" ? "folder" : "box")] || "✦"}</span>`;

const serviceButtons = (query = "") => {
  const normalized = query.trim().toLocaleLowerCase();
  const matches = services.filter((service) => !normalized || `${service.name} ${service.slug}`.toLocaleLowerCase().includes(normalized)).slice(0, 60);
  if (!matches.length) return `<p class="service-empty">Nessun servizio trovato</p>`;
  return matches.map((service) => `<button class="service-choice" type="button" data-service-id="${safe(service.id)}" data-service-icon="${safe(service.icon)}" title="${safe(service.name)}"><img src="${safe(service.icon)}" alt="" loading="lazy"/><span>${safe(service.name)}</span>${service.enhanced ? '<b title="Enhanced App">E</b>' : ""}</button>`).join("");
};
const percentage = (used: number, total: number) => total > 0 ? Math.min(100, used / total * 100) : 0;
const formatBytes = (value: number) => { const units = ["B", "KB", "MB", "GB", "TB"]; let size = Math.max(0, value); let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; } return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`; };
const metricCard = (key: string, label: string, detail = "Rilevamento…") => `<article class="metric-card"><div class="metric-head"><span>${label}</span><strong id="${key}-value">--</strong></div><svg class="sparkline" viewBox="0 0 180 44" preserveAspectRatio="none" aria-hidden="true"><polyline id="${key}-chart" points=""/></svg><small id="${key}-detail">${detail}</small></article>`;
const systemMetricCard = (key: string, label: string) => `<article class="metric-card donut-card"><div class="metric-head"><span>${label}</span><strong id="${key}-value">--</strong></div><div class="donut-body"><svg class="donut-chart" viewBox="0 0 44 44" aria-hidden="true"><circle class="donut-track" cx="22" cy="22" r="17"/><circle class="donut-value" id="${key}-chart" cx="22" cy="22" r="17" pathLength="100" stroke-dasharray="0 100"/></svg><small id="${key}-detail">Rilevamento…</small></div></article>`;

function toast(message: string) {
  let el = document.querySelector<HTMLDivElement>(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.append(el); }
  el.textContent = message;
  el.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el?.classList.remove("visible"), 2400);
}

async function persist() {
  try { await invoke("save_dashboard", { items: store.items, background: store.background }); }
  catch (error) { toast(`Salvataggio non riuscito: ${error}`); }
}

function render() {
  if (store.background) document.body.style.backgroundImage = `linear-gradient(180deg, rgba(10,13,17,.46), rgba(10,13,17,.76)), url("${store.background}")`;
  else document.body.style.removeProperty("background-image");
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="brand"><img class="brand-logo" src="/assets/branding/lucifer-logo-infernal.png" alt="Lucifer — Infernal Desktop" /></div>
        <div class="top-actions"><button class="icon-btn" id="background" title="Imposta uno sfondo personalizzato" aria-label="Imposta uno sfondo personalizzato">▧</button><button class="avatar" id="reset-background" title="Ripristina lo sfondo predefinito" aria-label="Ripristina lo sfondo predefinito">L</button><button class="add-button" id="add"><span>＋</span> Nuovo pulsante</button></div>
      </header>
      <section class="section-head"><div><span class="section-kicker">IL TUO DESKTOP</span><h2>Accessi rapidi <span>${store.items.length.toString().padStart(2, "0")}</span></h2></div></section>
      <section class="dashboard-workspace">
        <aside class="metrics-panel resources-panel"><div class="panel-heading"><span>RISORSE</span><b id="os-name">Sistema</b></div>${systemMetricCard("cpu", "CPU")}${systemMetricCard("memory", "RAM")}${systemMetricCard("gpu", "GPU")}${systemMetricCard("disk", "ARCHIVIAZIONE")}${systemMetricCard("swap", "SWAP")}</aside>
        <section class="grid">${store.items.map((item, index) => `<button class="tile" data-id="${safe(item.id)}" style="--delay:${index * 45}ms"><span class="tile-icon ${item.kind}">${iconFor(item)}</span><span class="tile-title">${safe(item.title)}</span><span class="tile-type">${item.kind === "app" ? "APPLICAZIONE" : item.kind === "url" ? "LINK WEB" : "DOCUMENTO"}</span><span class="tile-arrow">↗</span></button>`).join("")}
          <button class="tile add-tile" id="add-tile"><span class="plus-ring">＋</span><span class="tile-title">Aggiungi accesso</span><span class="tile-type">PERSONALIZZA IL TUO SPAZIO</span></button>
        </section>
        <aside class="metrics-panel network-panel"><div class="panel-heading"><span>RETE</span><i id="network-status"></i></div><div class="network-device"><span>CONNESSIONE ATTIVA</span><strong id="network-interface">Rilevamento…</strong><small id="network-address">--</small><small id="network-mac">--</small></div>${metricCard("download", "DOWNLOAD")}${metricCard("upload", "UPLOAD")}<div class="network-totals"><div><span>RICEVUTI</span><b id="network-total-down">--</b></div><div><span>INVIATI</span><b id="network-total-up">--</b></div></div></aside>
      </section>
      <footer class="footer"><span>Costa Fabio Copyright 2026</span></footer>
    </main>
    <div class="context-menu" id="context" hidden><button data-action="icon"><span>✳</span> Cambia icona</button><button data-action="edit"><span>✎</span> Modifica pulsante</button><div></div><button class="danger" data-action="delete"><span>⌫</span> Elimina</button></div>
    <div class="modal-backdrop" id="modal-backdrop" hidden><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button class="modal-close" id="modal-close" aria-label="Chiudi">×</button><div class="modal-kicker">CONFIGURA ACCESSO</div><h3 id="modal-title">Nuovo pulsante</h3><p class="modal-sub">Scegli come raggiungere ciò che ti serve.</p><div class="kind-switch"><button data-kind="app" class="active"><span>⌘</span> Applicazione</button><button data-kind="url"><span>↗</span> Link web</button><button data-kind="document"><span>▤</span> Documento</button></div><label class="field-label" for="item-title">NOME</label><input id="item-title" class="text-field" placeholder="Es. Il mio progetto" maxlength="36"/><label class="field-label" id="target-label" for="item-target">PERCORSO APPLICAZIONE</label><div class="target-row"><input id="item-target" class="text-field" placeholder="Percorso o comando"/><button id="browse" class="browse-btn" title="Sfoglia">…</button></div><label class="field-label" for="service-search">CATALOGO SERVIZI <span>${services.length}</span></label><input id="service-search" class="text-field service-search" type="search" placeholder="Cerca Plex, Home Assistant, Nextcloud…" autocomplete="off"/><div class="service-picker" id="service-picker">${serviceButtons()}</div><label class="field-label">ALTRE ICONE</label><div class="icon-picker">${Object.entries(glyphs).map(([name, icon]) => `<button class="icon-choice ${name === "star" ? "selected" : ""}" data-icon="${name}" title="${name}">${icon}</button>`).join("")}<button class="icon-choice upload-choice" id="upload-icon" title="Carica immagine">↑</button></div><button class="save-button" id="save-item">Aggiungi pulsante <span>→</span></button></section></div>`;

  app.querySelector("#add")?.addEventListener("click", () => showModal());
  app.querySelector("#add-tile")?.addEventListener("click", () => showModal());
  app.querySelector("#background")?.addEventListener("click", chooseBackground);
  app.querySelector("#reset-background")?.addEventListener("click", resetBackground);
  app.querySelectorAll<HTMLButtonElement>(".tile[data-id]").forEach((el) => {
    el.addEventListener("contextmenu", (event) => { event.preventDefault(); const rect = el.getBoundingClientRect(); contextPosition = { x: Math.min(event.clientX, innerWidth - 230), y: Math.min(event.clientY, innerHeight - 170) }; menuItem = store.items.find((item) => item.id === el.dataset.id) || null; showContext(); });
    el.addEventListener("click", async () => { if (Date.now() < suppressClickUntil) return; const item = store.items.find((entry) => entry.id === el.dataset.id); if (!item) return; try { if (item.kind === "url") await openUrl(item.target); else if (item.kind === "document") await openPath(item.target); else await invoke("launch_application", { target: item.target }); } catch (error) { toast(`Impossibile aprire: ${error}`); } });
    el.addEventListener("pointerdown", (event) => beginPointerDrag(event, el));
    el.addEventListener("pointermove", updatePointerDrag);
    el.addEventListener("pointerup", (event) => void endPointerDrag(event));
    el.addEventListener("pointercancel", cancelPointerDrag);
  });
  const grid = app.querySelector<HTMLElement>(".grid")!;
  grid.addEventListener("dragover", previewGridDrop);
  grid.addEventListener("drop", (event) => void dropItemAtPosition(event));
  grid.addEventListener("dragleave", (event) => { if (!grid.contains(event.relatedTarget as Node)) clearDropPreview(); });
  app.querySelector("#modal-close")?.addEventListener("click", hideModal);
  app.querySelector("#modal-backdrop")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) hideModal(); });
  app.querySelectorAll<HTMLButtonElement>(".kind-switch button").forEach((button) => button.addEventListener("click", () => setKind(button.dataset.kind as Item["kind"])));
  app.querySelectorAll<HTMLButtonElement>(".icon-choice[data-icon]").forEach((button) => button.addEventListener("click", () => chooseIcon(button.dataset.icon!)));
  app.querySelector("#service-search")?.addEventListener("input", (event) => renderServiceChoices((event.target as HTMLInputElement).value));
  bindServiceChoices();
  app.querySelector("#browse")?.addEventListener("click", browseTarget);
  app.querySelector("#upload-icon")?.addEventListener("click", uploadIcon);
  app.querySelector("#save-item")?.addEventListener("click", saveItem);
  app.querySelectorAll<HTMLButtonElement>(".context-menu button").forEach((button) => button.addEventListener("click", () => contextAction(button.dataset.action!)));
  app.querySelector("#context")?.addEventListener("contextmenu", (event) => event.preventDefault());
  void refreshSystemStats();
}

function pushHistory(key: keyof typeof histories, value: number) { histories[key].push(Number.isFinite(value) ? value : 0); if (histories[key].length > 45) histories[key].shift(); }
function chartPoints(values: number[], fixedMax = 100) {
  if (!values.length) return "";
  const max = fixedMax || Math.max(...values, 1);
  return values.map((value, index) => `${values.length === 1 ? 180 : index / (values.length - 1) * 180},${44 - Math.min(44, value / max * 42)}`).join(" ");
}
function setMetric(key: string, value: string, detail: string, history: number[], max = 100) {
  const valueElement = document.querySelector<HTMLElement>(`#${key}-value`); const detailElement = document.querySelector<HTMLElement>(`#${key}-detail`); const chart = document.querySelector<SVGElement>(`#${key}-chart`);
  if (valueElement) valueElement.textContent = value; if (detailElement) detailElement.textContent = detail;
  if (chart?.tagName.toLowerCase() === "circle") { const current = history.at(-1) || 0; chart.setAttribute("stroke-dasharray", `${Math.max(0, Math.min(100, current))} 100`); }
  else if (chart) chart.setAttribute("points", chartPoints(history, max));
}
async function refreshSystemStats() {
  if (!document.querySelector(".dashboard-workspace")) return;
  try {
    const stats = await invoke<SystemStats>("get_system_stats");
    const memoryPercent = percentage(stats.memoryUsed, stats.memoryTotal); const diskPercent = percentage(stats.diskUsed, stats.diskTotal); const swapPercent = percentage(stats.swapUsed, stats.swapTotal); const gpuUsage = stats.gpu?.usage ?? 0; const down = stats.network?.receivedPerSecond ?? 0; const up = stats.network?.transmittedPerSecond ?? 0;
    pushHistory("cpu", stats.cpuUsage); pushHistory("memory", memoryPercent); pushHistory("gpu", gpuUsage); pushHistory("disk", diskPercent); pushHistory("download", down); pushHistory("upload", up);
    setMetric("cpu", `${stats.cpuUsage.toFixed(0)}%`, stats.cpuName, histories.cpu);
    setMetric("memory", `${memoryPercent.toFixed(0)}%`, `${formatBytes(stats.memoryUsed)} / ${formatBytes(stats.memoryTotal)}`, histories.memory);
    setMetric("gpu", stats.gpu?.usage == null ? "N/D" : `${stats.gpu.usage.toFixed(0)}%`, stats.gpu?.name || "GPU non rilevata", histories.gpu);
    setMetric("disk", `${diskPercent.toFixed(0)}%`, `${formatBytes(stats.diskUsed)} / ${formatBytes(stats.diskTotal)}`, histories.disk);
    setMetric("swap", stats.swapTotal ? `${swapPercent.toFixed(0)}%` : "N/D", stats.swapTotal ? `${formatBytes(stats.swapUsed)} / ${formatBytes(stats.swapTotal)}` : "Non configurata", [swapPercent]);
    const trafficMax = Math.max(...histories.download, ...histories.upload, 1024);
    setMetric("download", `${formatBytes(down)}/s`, "Traffico in entrata", histories.download, trafficMax);
    setMetric("upload", `${formatBytes(up)}/s`, "Traffico in uscita", histories.upload, trafficMax);
    const os = document.querySelector("#os-name"); if (os) os.textContent = stats.operatingSystem;
    const iface = document.querySelector("#network-interface"); if (iface) iface.textContent = stats.network?.interface || "Disconnesso";
    const address = document.querySelector("#network-address"); if (address) address.textContent = stats.network?.ip || "Nessun indirizzo IP";
    const mac = document.querySelector("#network-mac"); if (mac) mac.textContent = stats.network?.mac || "--";
    const totalDown = document.querySelector("#network-total-down"); if (totalDown) totalDown.textContent = formatBytes(stats.network?.totalReceived || 0);
    const totalUp = document.querySelector("#network-total-up"); if (totalUp) totalUp.textContent = formatBytes(stats.network?.totalTransmitted || 0);
    document.querySelector("#network-status")?.classList.toggle("online", Boolean(stats.network));
  } catch (error) { console.error("Monitor di sistema:", error); }
}

function startItemDrag(event: DragEvent, element: HTMLButtonElement) {
  draggedItemId = element.dataset.id || null;
  pendingInsertIndex = null;
  if (!draggedItemId) return;
  element.classList.add("dragging");
  event.dataTransfer?.setData("text/plain", draggedItemId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}
function beginPointerDrag(event: PointerEvent, element: HTMLButtonElement) {
  if (event.button !== 0 || !element.dataset.id) return;
  pointerDrag = { id: element.dataset.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false, element };
  element.setPointerCapture(event.pointerId);
}
function updatePointerDrag(event: PointerEvent) {
  if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
  if (!pointerDrag.active && Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) > 7) {
    pointerDrag.active = true; draggedItemId = pointerDrag.id; pendingInsertIndex = null;
    pointerDrag.element.classList.add("dragging"); document.body.classList.add("reordering");
  }
  if (!pointerDrag.active) return;
  event.preventDefault(); previewGridPosition(event.clientX, event.clientY);
}
async function endPointerDrag(event: PointerEvent) {
  if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
  const wasActive = pointerDrag.active;
  if (pointerDrag.element.hasPointerCapture(event.pointerId)) pointerDrag.element.releasePointerCapture(event.pointerId);
  pointerDrag = null;
  if (!wasActive) return;
  event.preventDefault(); suppressClickUntil = Date.now() + 350;
  await reorderDraggedItem();
}
function cancelPointerDrag() { pointerDrag = null; document.body.classList.remove("reordering"); finishItemDrag(); }
function previewGridDrop(event: DragEvent) {
  if (!draggedItemId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  previewGridPosition(event.clientX, event.clientY);
}
function previewGridPosition(clientX: number, clientY: number) {
  const tiles = [...document.querySelectorAll<HTMLButtonElement>(".tile[data-id]")].filter((tile) => tile.dataset.id !== draggedItemId);
  if (!tiles.length) { pendingInsertIndex = 0; return; }
  const rows = new Map<number, HTMLButtonElement[]>();
  for (const tile of tiles) {
    const top = Math.round(tile.getBoundingClientRect().top);
    const row = [...rows.keys()].find((value) => Math.abs(value - top) < 5) ?? top;
    rows.set(row, [...(rows.get(row) || []), tile]);
  }
  const selectedRow = [...rows.values()].reduce((best, row) => {
    const rect = row[0].getBoundingClientRect();
    const distance = Math.abs(clientY - (rect.top + rect.height / 2));
    const bestRect = best[0].getBoundingClientRect();
    return distance < Math.abs(clientY - (bestRect.top + bestRect.height / 2)) ? row : best;
  });
  selectedRow.sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
  const nextTile = selectedRow.find((tile) => clientX < tile.getBoundingClientRect().left + tile.getBoundingClientRect().width / 2);
  clearDropPreview();
  if (nextTile) {
    nextTile.classList.add("drop-before");
    pendingInsertIndex = tiles.indexOf(nextTile);
  } else {
    const lastTile = selectedRow.at(-1)!;
    lastTile.classList.add("drop-after");
    pendingInsertIndex = tiles.indexOf(lastTile) + 1;
  }
}
async function dropItemAtPosition(event: DragEvent) {
  event.preventDefault();
  if (!draggedItemId) draggedItemId = event.dataTransfer?.getData("text/plain") || null;
  await reorderDraggedItem();
}
async function reorderDraggedItem() {
  const sourceId = draggedItemId;
  if (!sourceId || pendingInsertIndex === null) { finishItemDrag(); return; }
  const source = store.items.find((item) => item.id === sourceId);
  if (!source) { finishItemDrag(); return; }
  const remaining = store.items.filter((item) => item.id !== sourceId);
  remaining.splice(Math.max(0, Math.min(pendingInsertIndex, remaining.length)), 0, source);
  store.items = remaining;
  finishItemDrag(); render(); await persist(); toast("Posizione salvata");
}
function clearDropPreview() {
  document.querySelectorAll(".tile.drop-before,.tile.drop-after").forEach((tile) => tile.classList.remove("drop-before", "drop-after"));
}
function finishItemDrag() {
  draggedItemId = null;
  pendingInsertIndex = null;
  document.body.classList.remove("reordering");
  document.querySelectorAll(".tile.dragging,.tile.drop-before,.tile.drop-after").forEach((tile) => tile.classList.remove("dragging", "drop-before", "drop-after"));
}

function showContext() { const menu = document.querySelector<HTMLDivElement>("#context")!; menu.hidden = false; menu.style.left = `${contextPosition.x}px`; menu.style.top = `${contextPosition.y}px`; }
function hideContext() { const menu = document.querySelector<HTMLDivElement>("#context"); if (menu) menu.hidden = true; }
function showModal(item?: Item) {
  hideContext(); const backdrop = document.querySelector<HTMLDivElement>("#modal-backdrop")!; backdrop.hidden = false;
  document.querySelector("#modal-title")!.textContent = item ? "Modifica pulsante" : "Nuovo pulsante";
  (document.querySelector("#item-title") as HTMLInputElement).value = item?.title || "";
  (document.querySelector("#item-target") as HTMLInputElement).value = item?.target || "";
  (document.querySelector("#save-item") as HTMLButtonElement).innerHTML = `${item ? "Salva modifiche" : "Aggiungi pulsante"} <span>→</span>`;
  (backdrop as HTMLElement).dataset.editId = item?.id || "";
  (document.querySelector("#service-search") as HTMLInputElement).value = ""; renderServiceChoices();
  setKind(item?.kind || "app"); chooseIcon(item?.icon || "star");
  setTimeout(() => (document.querySelector("#item-title") as HTMLInputElement).focus(), 40);
}
function hideModal() { document.querySelector<HTMLDivElement>("#modal-backdrop")!.hidden = true; }
function setKind(kind: Item["kind"]) {
  document.querySelectorAll(".kind-switch button").forEach((button) => button.classList.toggle("active", (button as HTMLElement).dataset.kind === kind));
  const label = document.querySelector("#target-label")!; const input = document.querySelector<HTMLInputElement>("#item-target")!;
  label.textContent = kind === "app" ? "PERCORSO APPLICAZIONE" : kind === "url" ? "INDIRIZZO WEB" : "PERCORSO DOCUMENTO";
  input.placeholder = kind === "app" ? "Percorso o comando" : kind === "url" ? "https://esempio.it" : "Seleziona un documento";
  document.querySelector<HTMLButtonElement>("#browse")!.hidden = kind === "url";
  const backdrop = document.querySelector<HTMLElement>("#modal-backdrop")!; backdrop.dataset.kind = kind;
}
function chooseIcon(name: string) {
  const backdrop = document.querySelector<HTMLElement>("#modal-backdrop")!; backdrop.dataset.icon = name;
  document.querySelectorAll(".icon-choice[data-icon]").forEach((button) => button.classList.toggle("selected", (button as HTMLElement).dataset.icon === name));
  document.querySelectorAll(".service-choice").forEach((button) => button.classList.toggle("selected", (button as HTMLElement).dataset.serviceIcon === name));
}
function bindServiceChoices() {
  document.querySelectorAll<HTMLButtonElement>(".service-choice").forEach((button) => button.addEventListener("click", () => selectService(button.dataset.serviceId!)));
}
function renderServiceChoices(query = "") {
  const picker = document.querySelector<HTMLElement>("#service-picker");
  if (!picker) return;
  picker.innerHTML = serviceButtons(query); bindServiceChoices();
  const selected = document.querySelector<HTMLElement>("#modal-backdrop")?.dataset.icon;
  if (selected) document.querySelectorAll(".service-choice").forEach((button) => button.classList.toggle("selected", (button as HTMLElement).dataset.serviceIcon === selected));
}
function selectService(id: string) {
  const service = services.find((entry) => entry.id === id); if (!service) return;
  const title = document.querySelector<HTMLInputElement>("#item-title")!;
  if (!title.value.trim()) title.value = service.name;
  setKind("url");
  const backdrop = document.querySelector<HTMLElement>("#modal-backdrop")!; backdrop.dataset.icon = service.icon; backdrop.dataset.serviceId = service.id;
  document.querySelectorAll(".icon-choice").forEach((button) => button.classList.remove("selected"));
  document.querySelectorAll(".service-choice").forEach((button) => button.classList.toggle("selected", (button as HTMLElement).dataset.serviceId === service.id));
  document.querySelector<HTMLInputElement>("#item-target")!.focus();
}
async function browseTarget() {
  const kind = document.querySelector<HTMLElement>("#modal-backdrop")!.dataset.kind;
  const selected = await open({ multiple: false, directory: kind === "app", filters: kind === "document" ? [{ name: "Documenti", extensions: ["pdf", "txt", "doc", "docx", "odt", "png", "jpg"] }] : undefined });
  if (typeof selected === "string") (document.querySelector("#item-target") as HTMLInputElement).value = selected;
}
async function uploadIcon() {
  const selected = await open({ multiple: false, filters: [{ name: "Immagini", extensions: ["png", "jpg", "jpeg", "webp", "svg"] }] });
  if (typeof selected !== "string") return;
  try {
    document.querySelector<HTMLElement>("#modal-backdrop")!.dataset.icon = await invoke<string>("read_local_image", { path: selected });
    document.querySelectorAll(".icon-choice").forEach((button) => button.classList.remove("selected")); document.querySelector("#upload-icon")?.classList.add("selected");
  } catch (error) { toast(`Impossibile caricare l'icona: ${error}`); }
}
async function chooseBackground() {
  const selected = await open({ multiple: false, filters: [{ name: "Immagini", extensions: ["png", "jpg", "jpeg", "webp"] }] });
  if (typeof selected !== "string") return;
  try {
    store.background = await invoke<string>("read_local_image", { path: selected });
    render(); await persist(); toast("Sfondo aggiornato");
  } catch (error) { toast(`Impossibile caricare lo sfondo: ${error}`); }
}
async function resetBackground() {
  store.background = null;
  render(); await persist(); toast("Sfondo predefinito ripristinato");
}
async function saveItem() {
  const title = (document.querySelector("#item-title") as HTMLInputElement).value.trim();
  const target = (document.querySelector("#item-target") as HTMLInputElement).value.trim();
  const backdrop = document.querySelector<HTMLElement>("#modal-backdrop")!;
  if (!title || !target) { toast("Inserisci un nome e una destinazione"); return; }
  const existing = store.items.find((item) => item.id === backdrop.dataset.editId);
  const item: Item = { id: existing?.id || crypto.randomUUID(), title, target, kind: backdrop.dataset.kind as Item["kind"], icon: backdrop.dataset.icon || "star" };
  if (existing) store.items = store.items.map((entry) => entry.id === existing.id ? item : entry); else store.items.push(item);
  hideModal(); render(); await persist(); toast(existing ? "Pulsante aggiornato" : "Pulsante aggiunto");
}
async function contextAction(action: string) {
  const item = menuItem; hideContext(); if (!item) return;
  if (action === "delete") { store.items = store.items.filter((entry) => entry.id !== item.id); render(); await persist(); toast("Pulsante eliminato"); }
  if (action === "edit") showModal(item);
  if (action === "icon") { showModal(item); document.querySelector("#modal-title")!.textContent = "Cambia icona"; }
}
document.addEventListener("click", (event) => { if (!(event.target as HTMLElement).closest("#context")) hideContext(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { hideContext(); hideModal(); } });

async function initialize() {
  try { const catalog = await fetch("/service-icons/services.json").then((response) => response.json()) as ServiceCatalog; services = catalog.services; } catch { services = []; }
  try { store = await invoke<Store>("load_dashboard"); } catch { store = { items: [], background: null }; }
  render();
  window.clearInterval(statsTimer); statsTimer = window.setInterval(refreshSystemStats, 1000);
}

void initialize();
