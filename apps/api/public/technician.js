"use strict";
const byId = id => document.getElementById(id);
const safe = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[c]);
const number = value => Number(value || 0).toLocaleString("en-LC", { maximumFractionDigits: 4 });
const when = value => value ? new Date(value).toLocaleString("en-LC", { dateStyle: "medium", timeStyle: "short" }) : "—";
const state = { data: null, busy: false, requestKey: null, useKey: null };
function notice(message, error = false) {
  const el = byId("message");
  el.textContent = message;
  el.className = message ? error ? "notice error" : "notice success" : "";
}
function setBusy(value) {
  state.busy = value;
  document.querySelectorAll('form button[type="submit"]').forEach(button => { button.disabled = value; });
}
function authenticationNeeded(message) {
  byId("loading").hidden = true;
  byId("workspace").hidden = true;
  byId("signin").hidden = false;
  byId("location").textContent = "Hub authentication required";
  if (message) notice(message, true);
}
async function api(path, payload) {
  const response = await fetch(path, {
    method: payload ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: payload ? { "content-type": "application/json" } : {},
    body: payload ? JSON.stringify(payload) : undefined
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      authenticationNeeded(result.message || "Your technician session is unavailable. Relaunch POS from V79 Hub.");
    }
    throw Error(result.message || result.error || "Request failed (" + response.status + ")");
  }
  return result;
}
function variant(id) {
  return state.data?.products.find(item => item.id === id);
}
function option(id, label) {
  return '<option value="' + safe(id) + '">' + safe(label) + "</option>";
}
function productOptions(heldOnly = false) {
  const available = new Set((state.data.inventory || [])
    .filter(b => Number(b.available) > 0).map(b => b.productVariantId));
  const items = state.data.products.filter(p => !heldOnly || available.has(p.id));
  return option("", "Select stock item") +
    items.map(p => option(p.id, p.sku + " · " + p.product.name + " / " + p.name)).join("");
}
function parseSerials(input, productId) {
  const names = input.trim().split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
  const serials = names.map(name => {
    const row = state.data.serials.find(s =>
      s.productVariantId === productId && s.serialNumber.toLowerCase() === name.toLowerCase());
    if (!row) throw Error("Serial not assigned to your stock: " + name);
    return row.id;
  });
  if (new Set(serials).size !== serials.length) throw Error("A serial number was entered twice");
  return serials;
}
function parseLots(input, productId) {
  const terms = input.trim().split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
  const result = terms.map(term => {
    const index = term.lastIndexOf(":");
    if (index < 1) throw Error("Use lot-number:quantity for each lot");
    const name = term.slice(0, index).trim();
    const qty = Number(term.slice(index + 1).trim());
    const row = state.data.lots.find(l =>
      l.productVariantId === productId && l.lotNumber.toLowerCase() === name.toLowerCase());
    if (!row) throw Error("Lot not assigned to your stock: " + name);
    if (!Number.isFinite(qty) || qty <= 0) throw Error("Lot quantity must be positive");
    return { lotId: row.id, quantity: qty };
  });
  if (new Set(result.map(l => l.lotId)).size !== result.length) throw Error("A lot was entered twice");
  return result;
}
function controlledFields(productId, serialField, lotField) {
  return {
    serialNumberIds: parseSerials(byId(serialField).value, productId),
    lotAllocations: parseLots(byId(lotField).value, productId)
  };
}
function render() {
  const d = state.data;
  byId("location").textContent = d.location.name + " · Live POS inventory";
  byId("stat-items").textContent = number(d.inventory.filter(i => Number(i.onHand) > 0).length);
  byId("stat-units").textContent = number(d.inventory.reduce((sum, i) => sum + Math.max(0, Number(i.available)), 0));
  byId("stat-pending").textContent = number(d.transfers.filter(t => !["RECEIVED","CANCELLED"].includes(t.status)).length);
  const stock = d.inventory.filter(i => Number(i.onHand) > 0);
  byId("stock").innerHTML = stock.length ? stock.map(i =>
    '<article class="stock-item"><div><strong>' + safe(i.productVariant.product.name) +
    '</strong><small>' + safe(i.productVariant.sku) + ' · ' + safe(i.productVariant.name) +
    '</small></div><div class="count"><strong>' + number(i.available) + '</strong><small>available</small></div></article>'
  ).join("") : '<p class="empty">No assigned stock yet. Request equipment from your warehouse.</p>';
  byId("movements").innerHTML = d.transfers.length ? d.transfers.map(t =>
    '<article class="history-item"><div><strong>' + safe(t.purpose.replaceAll("_", " ")) +
    '</strong><small>' + safe(t.number) + ' · ' + safe(when(t.createdAt)) +
    '</small><small>' + safe(t.fromLocation.name) + ' → ' + safe(t.toLocation.name) +
    (t.jobReference ? " · Job " + safe(t.jobReference) : "") +
    '</small></div><span class="status">' + safe(t.status.replaceAll("_", " ")) + '</span></article>'
  ).join("") : '<p class="empty">No stock movements yet.</p>';
  byId("usage").innerHTML = d.usage.length ? d.usage.map(u => {
    const p = variant(u.productVariantId);
    return '<article class="history-item"><div><strong>' +
      safe(p?.product?.name || "Stock item") + '</strong><small>' +
      safe(u.jobReference) + ' · ' + safe(when(u.createdAt)) +
      '</small></div><span class="status">Used ' + number(u.quantity) + '</span></article>';
  }).join("") : '<p class="empty">No equipment used on jobs yet.</p>';
  byId("warehouse").innerHTML = option("", "Choose warehouse") +
    d.warehouses.map(w => option(w.id, w.name)).join("");
  byId("request-product").innerHTML = productOptions();
  byId("use-product").innerHTML = productOptions(true);
  byId("loading").hidden = true;
  byId("workspace").hidden = false;
  byId("signin").hidden = true;
}
async function refresh() {
  if (state.busy) return;
  byId("refresh").disabled = true;
  try {
    const result = await api("/v1/technician/workspace");
    state.data = result;
    notice("");
    render();
  } catch (error) {
    if (!byId("signin").hidden) return;
    notice(error.message, true);
    byId("loading").textContent = "Unable to load live stock. Use Refresh to retry.";
  } finally {
    byId("refresh").disabled = false;
  }
}
byId("request-form").addEventListener("input", () => { state.requestKey = null; });
byId("use-form").addEventListener("input", () => { state.useKey = null; });
byId("request-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.busy || !state.data) return;
  const form = event.currentTarget;
  const f = new FormData(form);
  const purpose = String(f.get("purpose"));
  const productVariantId = String(f.get("productVariantId"));
  const v = variant(productVariantId);
  if (!v) return notice("Choose a stock item.", true);
  if (purpose === "TECHNICIAN_ISSUE" &&
      (v.product.productType === "SERIALIZED" || v.product.productType === "LOT_TRACKED" || v.requiresExpiry)) {
    return notice("Serialised or lot-controlled equipment must be allocated by warehouse staff in Stock Control.", true);
  }
  try {
    const quantity = Number(f.get("quantity"));
    if (!Number.isFinite(quantity) || quantity <= 0) throw Error("Enter a valid positive quantity");
    const controlled = purpose === "TECHNICIAN_ISSUE"
      ? { serialNumberIds: [], lotAllocations: [] }
      : controlledFields(productVariantId, "request-serials", "request-lots");
    state.requestKey ||= crypto.randomUUID();
    setBusy(true);
    const transfer = await api("/v1/technician/requests", {
      requestKey: state.requestKey, purpose, warehouseId: String(f.get("warehouseId")),
      productVariantId, quantity, jobReference: String(f.get("jobReference")).trim() || undefined,
      reason: String(f.get("reason")).trim(), ...controlled
    });
    state.requestKey = null;
    form.reset();
    await refreshAfterMutation();
    notice("Request " + transfer.number + " submitted. Warehouse staff must approve and process it.");
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
});
byId("use-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.busy || !state.data) return;
  const form = event.currentTarget;
  const f = new FormData(form);
  const productVariantId = String(f.get("productVariantId"));
  try {
    const quantity = Number(f.get("quantity"));
    if (!Number.isFinite(quantity) || quantity <= 0) throw Error("Enter a valid positive quantity");
    const controlled = controlledFields(productVariantId, "use-serials", "use-lots");
    state.useKey ||= crypto.randomUUID();
    setBusy(true);
    await api("/v1/technician/use", {
      requestKey: state.useKey, productVariantId, quantity,
      jobReference: String(f.get("jobReference")).trim(), ...controlled
    });
    state.useKey = null;
    form.reset();
    await refreshAfterMutation();
    notice("Equipment use recorded against the job.");
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
});
async function refreshAfterMutation() {
  state.data = await api("/v1/technician/workspace");
  render();
}
byId("refresh").addEventListener("click", refresh);
byId("signout").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  authenticationNeeded("Signed out. Launch POS again from V79 Hub to sign in.");
});
refresh();
