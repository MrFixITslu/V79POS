const root = document.querySelector("#app");
const toastBox = document.querySelector("#toast");
const h = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const cash = (value) =>
  new Intl.NumberFormat("en-LC", { style: "currency", currency: "XCD" }).format(
    Number(value) || 0,
  );
const date = (value) =>
  value
    ? new Intl.DateTimeFormat("en-LC", { dateStyle: "medium" }).format(
        new Date(value),
      )
    : "—";
const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const key = () => crypto.randomUUID();
const tabs = [
  ["overview", "Overview", "▦"],
  ["register", "Register", "▣"],
  ["products", "Products", "◇"],
  ["inventory", "Inventory", "▤"],
  ["customers", "Customers", "♙"],
  ["sales", "Sales", "◴"],
  ["purchasing", "Purchasing", "⌁"],
  ["replenishment", "Replenishment", "↗"],
];
const state = {
  token: "",
  tenant: "",
  me: null,
  page: "overview",
  data: {},
  cart: [],
  reference: key(),
  selectedRegister: "",
  search: "",
  demo: false,
  busy: false,
};
let toastTimer;
function toast(message, error = false) {
  toastBox.textContent = message;
  toastBox.classList.toggle("error", error);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastBox.textContent = "";
    toastBox.classList.remove("error");
  }, 5500);
}
function can(permission) {
  return (
    state.demo ||
    !!state.me?.permissions?.some((p) => p === "*" || p === permission)
  );
}
function needs(permission) {
  return can(permission)
    ? ""
    : `<div class="empty">Your Hub role does not have access to this area.</div>`;
}
function demoData() {
  const now = new Date().toISOString();
  return {
    products: [
      {
        id: "p1",
        name: "Wireless Headphones",
        category: "Electronics",
        variants: [
          {
            id: "v1",
            name: "Standard",
            sku: "AUD-101",
            sellPrice: "149.00",
            taxRate: "0.125",
            trackStock: true,
          },
        ],
      },
      {
        id: "p2",
        name: "Coffee Beans",
        category: "Food & Drink",
        variants: [
          {
            id: "v2",
            name: "1 kg bag",
            sku: "CAF-220",
            sellPrice: "36.00",
            taxRate: "0",
            trackStock: true,
          },
        ],
      },
      {
        id: "p3",
        name: "Installation Service",
        category: "Services",
        variants: [
          {
            id: "v3",
            name: "Standard",
            sku: "SVC-101",
            sellPrice: "75.00",
            taxRate: "0.125",
            trackStock: false,
          },
        ],
      },
    ],
    registers: [
      {
        id: "reg1",
        name: "Front counter",
        locationId: "loc1",
        location: { name: "Main Store" },
        sessions: [{ id: "session1", status: "OPEN" }],
      },
    ],
    inventory: [
      {
        locationId: "loc1",
        location: { name: "Main Store" },
        productVariantId: "v1",
        productVariant: {
          sku: "AUD-101",
          name: "Standard",
          product: { name: "Wireless Headphones" },
        },
        onHand: "18",
        available: "18",
      },
      {
        locationId: "loc1",
        location: { name: "Main Store" },
        productVariantId: "v2",
        productVariant: {
          sku: "CAF-220",
          name: "1 kg bag",
          product: { name: "Coffee Beans" },
        },
        onHand: "7",
        available: "7",
      },
    ],
    customers: [
      {
        id: "c1",
        name: "Alicia Charles",
        email: "alicia@example.com",
        phone: "758-555-0102",
      },
    ],
    sales: [
      {
        id: "s1",
        number: "SALE-1024",
        total: "185.00",
        status: "COMPLETED",
        createdAt: now,
        customer: { name: "Alicia Charles" },
        payments: [{ method: "CASH" }],
      },
    ],
    suppliers: [
      {
        id: "sup1",
        name: "Island Wholesale",
        quotedLeadDays: 12,
        currency: "XCD",
      },
    ],
    purchaseOrders: [],
    recommendations: [
      {
        id: "r1",
        locationId: "loc1",
        productVariant: { product: { name: "Coffee Beans" }, sku: "CAF-220" },
        status: "ORDER_SOON",
        recommendedQty: "24",
        orderByAt: now,
        projectedStockoutAt: now,
        supplier: { name: "Island Wholesale" },
      },
    ],
    dashboard: {
      sales: { netRevenue: 185, orders: 1, averageSale: 185, grossProfit: 62 },
      inventory: { value: 2874, criticalReplenishmentItems: 1 },
      purchasing: { openPurchaseOrders: 0 },
      logistics: { delayedShipments: 0 },
    },
  };
}
async function api(path, options = {}) {
  if (state.demo)
    throw Error(
      "Demo mode is read-only. Connect a Hub account to save changes.",
    );
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(state.tenant ? { "x-v79-tenant-id": state.tenant } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    cache: "no-store",
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    if (response.status === 401) {
      state.token = "";
      state.me = null;
      renderLogin();
    }
    throw Error(
      body.message || body.error || `Request failed (${response.status})`,
    );
  }
  return body;
}
async function load() {
  if (state.demo) {
    state.data = demoData();
    state.selectedRegister = "reg1";
    return;
  }
  const requests = [
    ["products", "/v1/products", "catalogue.read"],
    ["registers", "/v1/registers", "register.read"],
    ["inventory", "/v1/inventory", "inventory.read"],
    ["customers", "/v1/customers?limit=200", "customers.read"],
    ["sales", "/v1/sales?limit=50", "sales.read"],
    ["suppliers", "/v1/suppliers", "procurement.read"],
    ["purchaseOrders", "/v1/purchase-orders", "procurement.read"],
    ["recommendations", "/v1/replenishment", "replenishment.read"],
    ["dashboard", "/v1/reports/dashboard", "reports.read"],
  ];
  const results = await Promise.allSettled(
    requests.map(async ([key, path, permission]) => [
      key,
      can(permission) ? await api(path) : {},
    ]),
  );
  for (const result of results) {
    if (result.status === "fulfilled") {
      const [k, value] = result.value;
      state.data[k] = value[k] ?? value;
    } else if (state.me) toast(result.reason.message, true);
  }
  if (
    !state.selectedRegister ||
    !state.data.registers?.some((r) => r.id === state.selectedRegister)
  )
    state.selectedRegister = state.data.registers?.[0]?.id || "";
}
function field(name, label, type = "text", value = "", extra = "") {
  return `<div class="field"><label for="${h(name)}">${h(label)}</label><input id="${h(name)}" name="${h(name)}" type="${h(type)}" value="${h(value)}" ${extra}></div>`;
}
function select(name, label, options, blank = "Select…") {
  return `<div class="field"><label for="${h(name)}">${h(label)}</label><select id="${h(name)}" name="${h(name)}" ${name === "customerId" ? "" : "required"}><option value="">${h(blank)}</option>${options.map(([value, text]) => `<option value="${h(value)}">${h(text)}</option>`).join("")}</select></div>`;
}
function header(title, description, action = "") {
  return `<div class="pagehead"><div><div class="eyebrow">V79 DIGITAL POS / ${h(state.page)}</div><h1>${h(title)}</h1><p>${h(description)}</p></div>${action}</div>`;
}
function badge(text) {
  let kind = /STOCKED|RISK|FAILED|CANCELLED/.test(text)
    ? "bad"
    : /SOON|PENDING|DRAFT|CLOSED|LOW/.test(text)
      ? "warn"
      : "";
  return `<span class="pill ${kind}">${h(text.replaceAll("_", " "))}</span>`;
}
function empty(text) {
  return `<div class="empty">${h(text)}</div>`;
}
function table(headers, rows) {
  return `<div class="table-wrap"><table class="table"><thead><tr>${headers.map((x) => `<th>${h(x)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}
function renderLogin() {
  root.innerHTML = `<div class="login"><div class="login-art"><div class="logo-large"><span class="logo-orb">V</span><span>V79 Digital <b>POS</b></span></div><div class="login-copy"><div class="eyebrow">From Idea to Advantage.</div><h1>Run sales, stock and replenishment from one commerce workspace.</h1><p>Serve customers quickly, protect inventory availability and act on reorder signals before stock runs out.</p><div class="login-points"><span>Sales & checkout</span><span>Inventory intelligence</span><span>Purchasing & lead times</span></div></div><div class="footnote">V79 Digital · Commerce Workspace</div></div><main id="main" class="login-panel"><div class="card login-card"><span class="pill">HUB MANAGED ACCESS</span><h2>Open V79 Digital POS</h2><p class="muted">POS is launched securely from your V79 Digital Hub workspace.</p><a class="btn primary" href="https://hub.v79sl.com/">Back to V79 Digital Hub →</a><button class="btn" data-action="demo">Explore demo workspace</button><div class="notice" style="margin-top:14px">Use the Hub to launch your assigned business workspace. Demo mode uses sample data and never saves sales.</div><details><summary>Integration testing</summary><p class="footnote">For authorised Hub integration testing only. Short-lived access tokens remain in this browser tab and clear on refresh.</p><form id="connect-form">${field("token", "POS access token", "password", "", 'required autocomplete="off"')}${field("tenant", "Hub organisation ID", "text", "", 'required autocomplete="off"')}<button class="btn dark" type="submit">Connect workspace</button></form></details></div></main></div>`;
}
function render() {
  if (!state.me && !state.demo) return renderLogin();
  const title = state.demo
    ? "Preview workspace"
    : state.me?.roleKey || "Workspace";
  root.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">V</span><span>V79 POS<small>BY V79 DIGITAL</small></span></div><div class="nav-label">Commerce</div><nav class="nav" aria-label="Main navigation">${tabs.map(([id, label, icon]) => `<button data-page="${id}" class="${state.page === id ? "active" : ""}" aria-current="${state.page === id ? "page" : "false"}"><span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`).join("")}</nav><div class="sidebar-foot"><strong>${state.demo ? "Demo workspace" : "Workspace connected"}</strong><span class="connection"><i></i>${state.demo ? "Sample data · no changes saved" : `Hub role: ${h(title)}`}</span></div><a class="hub-link" href="https://hub.v79sl.com/">← Back to V79 Digital Hub</a><div class="sidebar-tagline">From Idea to Advantage.</div></aside><div class="work"><header class="topbar"><div><div class="top-eyebrow">Active workspace</div><strong>${state.demo ? "Demo business" : h(state.me?.roleKey || "Business workspace")}</strong><div class="meta">${state.demo ? "Preview only" : "V79 Digital Hub membership verified"}</div></div><div class="top-actions"><span class="statusline"><span class="dot"></span>${state.demo ? "Preview" : "Operational"}</span><button class="btn compact" data-action="refresh">Refresh</button><button class="btn compact" data-action="signout">${state.demo ? "Exit demo" : "Sign out"}</button></div></header><main class="content" id="main">${pages[state.page]()}</main></div></div>`;
}
const metric = (label, value, note, tone = "") =>
  `<div class="card metric ${h(tone)}"><div class="metric-top"><div class="label">${h(label)}</div><span>LIVE</span></div><strong>${h(value)}</strong><small>${h(note)}</small></div>`;
function overview() {
  if (!can("reports.read"))
    return (
      header("Overview", "Your business at a glance") + needs("reports.read")
    );
  const d = state.data.dashboard || {},
    s = d.sales || {},
    i = d.inventory || {},
    p = d.purchasing || {};
  return (
    header(
      "Commerce overview",
      "Live sales, margin, inventory and supply signals across this workspace",
      `<div class="actions"><button class="btn primary" data-page="register">New sale →</button></div>`,
    ) +
    `<div class="grid metric-grid">${metric("Net revenue · 30 days", cash(s.netRevenue), "After refunds", "revenue")}${metric("Completed sales", s.orders || 0, "Last 30 days", "orders")}${metric("Average sale", cash(s.averageSale), "Per completed order", "average")}${metric("Gross profit", cash(s.grossProfit), "Before operating expenses", "profit")}${metric("Stock at risk", i.criticalReplenishmentItems || 0, "Reorder alerts", Number(i.criticalReplenishmentItems || 0) > 0 ? "risk" : "healthy")}</div><div class="ops-banner"><div><span class="ops-kicker">Inventory intelligence</span><strong>${Number(i.criticalReplenishmentItems || 0) > 0 ? `${h(i.criticalReplenishmentItems)} item(s) need replenishment attention` : "No critical replenishment signals"}</strong><small>Recommendations use demand, lead time and safety stock policy.</small></div><button class="btn" data-page="replenishment">Review signals →</button></div><div class="split"><section class="card section"><div class="row"><div><h2>Recent sales</h2><p class="section-note">Latest completed and recorded transactions</p></div><button class="btn compact" data-page="sales">View all</button></div>${
      (state.data.sales || []).length
        ? table(
            ["Sale", "Customer", "Date", "Total"],
            state.data.sales
              .slice(0, 5)
              .map(
                (x) =>
                  `<tr><td><strong>${h(x.number)}</strong></td><td>${h(x.customer?.name || "Walk-in")}</td><td>${h(date(x.createdAt))}</td><td><strong>${cash(x.total)}</strong></td></tr>`,
              ),
          )
        : empty(
            "No sales recorded yet. Open a register and create your first sale.",
          )
    }</section><section class="card section operations-card"><div><h2>Operations snapshot</h2><p class="section-note">Stock and inbound supply position</p></div><div class="ops-stat"><span>Inventory value</span><strong>${cash(i.value)}</strong></div><div class="ops-stat"><span>Open purchase orders</span><strong>${h(p.openPurchaseOrders || 0)}</strong></div><div class="ops-stat"><span>Delayed shipments</span><strong class="${Number(d.logistics?.delayedShipments || 0) > 0 ? "danger-text" : ""}">${h(d.logistics?.delayedShipments || 0)}</strong></div><hr class="divider"><button class="btn wide" data-page="purchasing">Open purchasing →</button></section></div>`
  );
}
function variants() {
  return (state.data.products || []).flatMap((p) =>
    (p.variants || []).map((v) => ({ ...v, product: p })),
  );
}
function currentRegister() {
  return (state.data.registers || []).find(
    (r) => r.id === state.selectedRegister,
  );
}
function balance(id, location) {
  return (state.data.inventory || []).find(
    (b) => b.productVariantId === id && b.locationId === location,
  );
}
function totals() {
  const lines = state.cart.map((item) => {
    const v = variants().find((x) => x.id === item.id);
    const gross = round(Number(v?.sellPrice || 0) * item.quantity);
    const tax = round(gross * Number(v?.taxRate || 0));
    return { gross, tax, total: round(gross + tax) };
  });
  return {
    subtotal: round(lines.reduce((a, x) => a + x.gross, 0)),
    tax: round(lines.reduce((a, x) => a + x.tax, 0)),
    total: round(lines.reduce((a, x) => a + x.total, 0)),
  };
}
function register() {
  if (!can("sales.create"))
    return header("Register", "Checkout and tender") + needs("sales.create");
  const r = currentRegister(),
    open = r?.sessions?.[0],
    matching = variants().filter((v) =>
      (v.product.name + " " + v.name + " " + v.sku + " " + (v.barcode || ""))
        .toLowerCase()
        .includes(state.search.toLowerCase()),
    );
  const t = totals();
  return (
    header(
      "Point of sale",
      "Fast checkout with clear totals and register controls",
      `<div class="actions"><select id="register-select" class="btn" aria-label="Register">${(state.data.registers || []).map((x) => `<option value="${h(x.id)}" ${x.id === state.selectedRegister ? "selected" : ""}>${h(x.location?.name)} · ${h(x.name)}</option>`).join("")}</select><button class="btn" data-action="${open ? "close-register" : "open-register"}" ${r ? "" : "disabled"}>${open ? "Close register" : "Open register"}</button></div>`,
    ) +
    (!r
      ? empty(
          "No register is assigned. Connect a POS workspace in Hub to create your first location and register.",
        )
      : !open
        ? `<div class="notice warn">Register is closed. Open it before taking payments.</div>`
        : `<div class="notice">${h(r.name)} is open · sales are recorded at ${h(r.location?.name)}</div>`) +
    `<div class="register-layout"><section class="card"><div class="row"><h2>Catalogue</h2><span class="muted">${matching.length} items</span></div><input class="search" id="product-search" type="search" placeholder="Search name, SKU or barcode" aria-label="Search products" value="${h(state.search)}"><div class="product-grid">${
      matching
        .map((v) => {
          const stock = balance(v.id, r?.locationId),
            available = Number(stock?.available || 0),
            blocked = v.trackStock && available <= 0;
          return `<button class="product" data-add="${h(v.id)}" ${blocked ? "disabled" : ""}><div><small>${h(v.sku)}</small><br><strong>${h(v.product.name)}</strong><br><small>${h(v.name)}</small></div><div class="row"><b>${cash(v.sellPrice)}</b><small>${v.trackStock ? (blocked ? "Out of stock" : `${h(available)} available`) : "Service"}</small></div></button>`;
        })
        .join("") || empty("No matching items. Add a product to begin.")
    }</div></section><aside class="card section cart"><div class="row"><h2>Current sale</h2><button class="btn" data-action="clear-cart" ${state.cart.length ? "" : "disabled"}>Clear</button></div>${
      state.cart.length
        ? state.cart
            .map((item) => {
              const v = variants().find((x) => x.id === item.id);
              return `<div class="row"><div><strong>${h(v?.product.name || "Item")}</strong><small class="muted" style="display:block">${h(v?.name)} · ${cash(v?.sellPrice)}</small></div><div class="row"><button class="btn" data-qty="${h(item.id)}:-1" aria-label="Remove one">−</button><strong>${h(item.quantity)}</strong><button class="btn" data-qty="${h(item.id)}:1" aria-label="Add one">+</button></div></div>`;
            })
            .join("")
        : empty("Tap a product to add it to this sale.")
    }<hr class="divider"><div class="row"><span>Subtotal</span><strong>${cash(t.subtotal)}</strong></div><div class="row"><span>Estimated tax</span><strong>${cash(t.tax)}</strong></div><hr class="divider"><div class="row total"><span>Total</span><span>${cash(t.total)}</span></div><p class="footnote">Final pricing and tax are calculated by the server at checkout.</p><button class="btn primary" data-action="checkout" style="width:100%" ${!state.cart.length || !open || state.busy ? "disabled" : ""}>Charge ${cash(t.total)} →</button></aside></div>`
  );
}
function products() {
  if (!can("catalogue.read"))
    return header("Products", "Your catalogue") + needs("catalogue.read");
  const rows = variants().map(
    (v) =>
      `<tr><td><strong>${h(v.product.name)}</strong><small>${h(v.name)}</small></td><td>${h(v.sku)}</td><td>${h(v.product.category || "—")}</td><td>${cash(v.sellPrice)}</td><td>${v.trackStock ? "Tracked" : "Service"}</td></tr>`,
  );
  return (
    header(
      "Product catalogue",
      "Products, variants and selling prices",
      can("catalogue.write")
        ? `<button class="btn primary" data-modal="product">+ Add product</button>`
        : "",
    ) +
    `<section class="card section">${rows.length ? table(["Product", "SKU", "Category", "Price", "Stock"], rows) : empty("No products yet. Add your first product to start selling.")}</section>`
  );
}
function inventory() {
  if (!can("inventory.read"))
    return header("Inventory", "Stock levels") + needs("inventory.read");
  const rows = (state.data.inventory || []).map(
    (x) =>
      `<tr><td><strong>${h(x.productVariant?.product?.name)}</strong><small>${h(x.productVariant?.sku)}</small></td><td>${h(x.location?.name)}</td><td>${h(x.onHand)}</td><td>${h(x.available)}</td><td>${Number(x.available) <= 0 ? badge("STOCKED OUT") : Number(x.available) < 5 ? badge("LOW") : badge("HEALTHY")}</td></tr>`,
  );
  return (
    header(
      "Inventory",
      "Live stock balances by location",
      can("inventory.adjust")
        ? `<button class="btn primary" data-modal="adjustment">+ Adjust stock</button>`
        : "",
    ) +
    `<section class="card section">${rows.length ? table(["Product", "Location", "On hand", "Available", "Status"], rows) : empty("No stock balances yet. Receive stock or make an authorised adjustment.")}</section>`
  );
}
function customers() {
  if (!can("customers.read"))
    return header("Customers", "Customer directory") + needs("customers.read");
  const rows = (state.data.customers || []).map(
    (x) =>
      `<tr><td><strong>${h(x.name)}</strong></td><td>${h(x.email || "—")}</td><td>${h(x.phone || "—")}</td><td>${x.marketingConsent ? badge("OPTED IN") : "—"}</td></tr>`,
  );
  return (
    header(
      "Customers",
      "Customer records and contact details",
      can("customers.write")
        ? `<button class="btn primary" data-modal="customer">+ Add customer</button>`
        : "",
    ) +
    `<section class="card section">${rows.length ? table(["Name", "Email", "Phone", "Marketing"], rows) : empty("No customers yet. Walk-in checkout is available without a customer record.")}</section>`
  );
}
function sales() {
  if (!can("sales.read"))
    return header("Sales", "Transaction history") + needs("sales.read");
  const rows = (state.data.sales || []).map(
    (x) =>
      `<tr><td><strong>${h(x.number)}</strong><small>${h(date(x.createdAt))}</small></td><td>${h(x.customer?.name || "Walk-in")}</td><td>${h(x.payments?.map((p) => p.method.replaceAll("_", " ")).join(", ") || "—")}</td><td>${badge(x.status)}</td><td><strong>${cash(x.total)}</strong></td></tr>`,
  );
  return (
    header(
      "Sales history",
      "Recent transactions and payment methods",
      `<button class="btn primary" data-page="register">+ New sale</button>`,
    ) +
    `<section class="card section">${rows.length ? table(["Sale", "Customer", "Payment", "Status", "Total"], rows) : empty("No sales to display.")}</section>`
  );
}
function purchasing() {
  if (!can("procurement.read"))
    return (
      header("Purchasing", "Suppliers and purchase orders") +
      needs("procurement.read")
    );
  const orders = (state.data.purchaseOrders || []).map(
    (x) =>
      `<tr><td><strong>${h(x.number)}</strong></td><td>${h(x.supplier?.name)}</td><td>${h(x.shipTo?.name)}</td><td>${badge(x.status)}</td><td>${h(date(x.expectedAt))}</td><td>${x.status === "DRAFT" && can("procurement.approve") ? `<button class="btn" data-approve="${h(x.id)}">Approve</button>` : ""}${!["RECEIVED", "CLOSED", "CANCELLED"].includes(x.status) && can("receiving.write") ? `<button class="btn" data-receive="${h(x.id)}">Receive</button>` : ""}</td></tr>`,
  );
  const suppliers = (state.data.suppliers || []).map(
    (x) =>
      `<tr><td><strong>${h(x.name)}</strong></td><td>${h(x.quotedLeadDays ?? "—")} days</td><td>${h(x.email || "—")}</td></tr>`,
  );
  return (
    header(
      "Purchasing",
      "Suppliers, lead times and incoming orders",
      can("procurement.write")
        ? `<div class="actions"><button class="btn" data-modal="supplier-link">Link supplier product</button><button class="btn" data-modal="supplier">+ Add supplier</button><button class="btn primary" data-modal="purchase-order">+ Purchase order</button></div>`
        : "",
    ) +
    `<div class="split"><section class="card section"><h2>Purchase orders</h2>${orders.length ? table(["PO", "Supplier", "Destination", "Status", "Expected", "Actions"], orders) : empty("No purchase orders yet. Link a product to a supplier, then create an order.")}</section><section class="card section"><h2>Suppliers</h2>${suppliers.length ? table(["Name", "Lead time", "Email"], suppliers) : empty("No suppliers configured.")}</section></div>`
  );
}
function replenishment() {
  if (!can("replenishment.read"))
    return (
      header("Replenishment", "Smart stock planning") +
      needs("replenishment.read")
    );
  const rows = (state.data.recommendations || []).map(
    (x) =>
      `<tr><td><strong>${h(x.productVariant?.product?.name || "Product")}</strong><small>${h(x.productVariant?.sku || "")}</small></td><td>${badge(x.status)}</td><td>${h(x.recommendedQty)}</td><td>${h(date(x.orderByAt))}</td><td>${h(x.supplier?.name || "No supplier")}</td><td>${x.supplier && Number(x.recommendedQty) > 0 && can("procurement.write") ? `<input type="checkbox" class="reorder-check" value="${h(x.id)}" aria-label="Select ${h(x.productVariant?.product?.name)}">` : ""}</td></tr>`,
  );
  return (
    header(
      "Smart replenishment",
      "Order timing based on demand, lead time and safety stock",
      `<div class="actions">${can("replenishment.manage") ? '<button class="btn" data-modal="policy">Set reorder policy</button>' : ""}${can("replenishment.run") ? '<button class="btn" data-action="recalculate">Recalculate</button>' : ""}${can("procurement.write") ? '<button class="btn primary" data-action="draft-pos">Create draft POs</button>' : ""}</div>`,
    ) +
    `<section class="card section">${rows.length ? table(["Product", "Status", "Order qty", "Order by", "Supplier", "Select"], rows) : empty("No recommendations yet. Set a replenishment policy and run a calculation.")}</section>`
  );
}
const pages = {
  overview,
  register,
  products,
  inventory,
  customers,
  sales,
  purchasing,
  replenishment,
};
function modal(title, contents, id, button = "Save") {
  const old = document.querySelector("#dialog");
  old?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "dialog";
  dialog.className = "dialog";
  dialog.innerHTML = `<form class="dialog-inner" id="${h(id)}"><h2>${h(title)}</h2>${state.demo ? '<div class="notice warn">Preview only · changes are disabled in demo mode.</div>' : ""}<div class="form-grid">${contents}</div><div class="form-actions"><button class="btn" type="button" data-action="close-dialog">Cancel</button><button class="btn primary" type="submit" ${state.demo ? "disabled" : ""}>${state.demo ? "Preview only" : h(button)}</button></div></form>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector("input,select")?.focus();
}
function openModal(name) {
  const locations = [
    ...new Map(
      (state.data.registers || []).map((r) => [
        r.locationId,
        [r.locationId, r.location?.name || r.name],
      ]),
    ).values(),
  ];
  if (name === "product")
    modal(
      "Add a product",
      field("name", "Product name", "text", "", 'required maxlength="160"') +
        field("sku", "SKU", "text", "", 'required maxlength="100"') +
        field("category", "Category") +
        field(
          "price",
          "Selling price (XCD)",
          "number",
          "",
          'required min="0" step="0.01"',
        ) +
        field("cost", "Unit cost (XCD)", "number", "0", 'min="0" step="0.01"') +
        field(
          "tax",
          "Tax rate (%)",
          "number",
          "0",
          'min="0" max="100" step="0.01"',
        ) +
        select("kind", "Product type", [
          ["STANDARD", "Stocked product"],
          ["SERVICE", "Service"],
          ["NON_STOCK", "Non-stock item"],
        ]) +
        `<div class="field"><label><input type="checkbox" name="trackStock" checked> Track stock</label></div>`,
      "product-form",
      "Create product",
    );
  if (name === "customer")
    modal(
      "Add a customer",
      field("name", "Full name", "text", "", "required") +
        field("email", "Email", "email") +
        field("phone", "Phone", "tel") +
        `<div class="field wide"><label><input type="checkbox" name="marketingConsent"> Customer opted in to marketing</label></div>`,
      "customer-form",
      "Create customer",
    );
  if (name === "supplier")
    modal(
      "Add a supplier",
      field("name", "Supplier name", "text", "", "required") +
        field("email", "Email", "email") +
        field("phone", "Phone", "tel") +
        field(
          "lead",
          "Quoted lead time (days)",
          "number",
          "14",
          'min="0" max="365"',
        ),
      "supplier-form",
      "Create supplier",
    );
  if (name === "supplier-link")
    modal(
      "Link a product to a supplier",
      select(
        "supplierId",
        "Supplier",
        (state.data.suppliers || []).map((s) => [s.id, s.name]),
      ) +
        select(
          "variantId",
          "Product",
          variants()
            .filter((v) => v.trackStock)
            .map((v) => [v.id, `${v.product.name} · ${v.sku}`]),
        ) +
        field(
          "cost",
          "Supplier unit cost (XCD)",
          "number",
          "",
          'required min="0" step="0.01"',
        ) +
        field(
          "moq",
          "Minimum order quantity",
          "number",
          "0",
          'required min="0" step="any"',
        ) +
        field(
          "casePack",
          "Case pack",
          "number",
          "1",
          'required min="0.001" step="any"',
        ) +
        `<div class="field wide"><label><input type="checkbox" name="preferred"> Preferred supplier for this product</label></div>`,
      "supplier-link-form",
      "Link product",
    );
  if (name === "purchase-order")
    modal(
      "Create purchase order",
      `<div class="field wide notice">Link the product to this supplier before creating an order.</div>` +
        select(
          "supplierId",
          "Supplier",
          (state.data.suppliers || []).map((s) => [s.id, s.name]),
        ) +
        select("locationId", "Delivery location", locations) +
        select(
          "variantId",
          "Product",
          variants()
            .filter((v) => v.trackStock)
            .map((v) => [v.id, `${v.product.name} · ${v.sku}`]),
        ) +
        field(
          "quantity",
          "Order quantity",
          "number",
          "",
          'required min="0.001" step="any"',
        ) +
        field("expectedAt", "Expected delivery", "date") +
        field("notes", "Notes"),
      "purchase-order-form",
      "Create draft order",
    );
  if (name === "policy")
    modal(
      "Set reorder policy",
      select("locationId", "Location", locations) +
        select(
          "variantId",
          "Product",
          variants()
            .filter((v) => v.trackStock)
            .map((v) => [v.id, `${v.product.name} · ${v.sku}`]),
        ) +
        select(
          "supplierId",
          "Preferred supplier (linked products only)",
          (state.data.suppliers || []).map((s) => [s.id, s.name]),
          "No preferred supplier",
        ) +
        field(
          "safety",
          "Safety stock units",
          "number",
          "0",
          'required min="0" step="any"',
        ) +
        field(
          "review",
          "Review period (days)",
          "number",
          "14",
          'required min="1" max="365"',
        ) +
        field(
          "lead",
          "Planning lead time (days)",
          "number",
          "14",
          'min="0" max="365"',
        ) +
        field(
          "demand",
          "Daily demand override (optional)",
          "number",
          "",
          'min="0" step="any"',
        ),
      "policy-form",
      "Save policy",
    );
  if (name === "receipt") {
    const order = (state.data.purchaseOrders || []).find(
      (po) => po.id === state.selectedOrder,
    );
    if (!order) return toast("Purchase order not found", true);
    const lines = order.lines.filter(
      (line) => Number(line.orderedQty) > Number(line.receivedQty),
    );
    if (!lines.length)
      return toast("Nothing remains to receive on this order", true);
    modal(
      `Receive ${order.number}`,
      select(
        "lineId",
        "Purchase order line",
        lines.map((line) => [
          line.id,
          `${line.productVariant?.sku || "Product"} · ${round(Number(line.orderedQty) - Number(line.receivedQty))} outstanding`,
        ]),
      ) +
        field(
          "quantity",
          "Quantity received",
          "number",
          "",
          'required min="0.001" step="any"',
        ) +
        field("lot", "Lot number (for lot-tracked products)") +
        field("expiry", "Expiry date (if required)", "date") +
        `<div class="field wide"><label for="serials">Serial numbers (one per line, if serialized)</label><textarea id="serials" name="serials"></textarea></div>` +
        field(
          "additionalCosts",
          "Additional landed costs (XCD)",
          "number",
          "0",
          'min="0" step="0.01"',
        ),
      "receipt-form",
      "Receive stock",
    );
  }
  if (name === "adjustment")
    modal(
      "Adjust stock",
      select("locationId", "Location", locations) +
        select(
          "variantId",
          "Product",
          variants()
            .filter((v) => v.trackStock)
            .map((v) => [v.id, `${v.product.name} · ${v.sku}`]),
        ) +
        select("type", "Movement", [
          ["ADJUSTMENT_GAIN", "Add stock"],
          ["ADJUSTMENT_LOSS", "Remove stock"],
          ["DAMAGE", "Damage"],
          ["EXPIRY", "Expired"],
        ]) +
        field(
          "quantity",
          "Quantity",
          "number",
          "",
          'required min="0.001" step="any"',
        ) +
        `<div class="field wide"><label for="reason">Reason</label><textarea id="reason" name="reason" required minlength="3" maxlength="500"></textarea></div>`,
      "adjustment-form",
      "Record adjustment",
    );
  if (name === "checkout") {
    const t = totals();
    modal(
      "Complete sale",
      `<div class="field wide notice">${state.cart.length} item(s) · estimated total <strong>${cash(t.total)}</strong>. Server totals may change if promotions or customer pricing apply.</div>` +
        select(
          "customerId",
          "Customer (optional)",
          (state.data.customers || []).map((x) => [x.id, x.name]),
          "Walk-in customer",
        ) +
        select("method", "Payment method", [
          ["CASH", "Cash"],
          ["EXTERNAL_TERMINAL", "External card terminal"],
          ["BANK_TRANSFER", "Bank transfer"],
          ["MOBILE_WALLET", "Mobile wallet"],
        ]) +
        field(
          "paid",
          "Amount received (XCD)",
          "number",
          t.total.toFixed(2),
          'required min="0.01" step="0.01"',
        ) +
        field(
          "providerRef",
          "External payment reference (required unless cash)",
        ) +
        `<div class="field wide"><label for="memo">Sale reference</label><input id="memo" value="${h(state.reference)}" readonly></div>`,
      "checkout-form",
      "Complete sale",
    );
  }
  if (name === "open-register")
    modal(
      "Open register",
      field(
        "float",
        "Opening cash float (XCD)",
        "number",
        "0",
        'required min="0" step="0.01"',
      ),
      "open-form",
      "Open register",
    );
  if (name === "close-register")
    modal(
      "Close register",
      field(
        "cash",
        "Cash counted (XCD)",
        "number",
        "",
        'required min="0" step="0.01"',
      ) + field("notes", "Notes"),
      "close-form",
      "Close register",
    );
}
async function connect(token, tenant) {
  state.token = token.trim();
  state.tenant = tenant.trim();
  state.demo = false;
  state.data = {};
  try {
    state.me = await api("/v1/me");
    state.tenant = state.me.tenantId;
    await load();
    render();
    toast("Workspace connected");
  } catch (err) {
    state.token = "";
    state.me = null;
    renderLogin();
    toast(`Could not connect: ${err.message}`, true);
  }
}
// A Hub popup can transfer its short-lived POS JWT without putting it in a URL.
// The API still verifies issuer, audience, signature and active membership.
const hubOrigin = "https://hub.v79sl.com";
window.addEventListener("message", (event) => {
  if (event.origin !== hubOrigin || event.source !== window.opener) return;
  const data = event.data;
  if (
    data?.type === "v79-pos-auth" &&
    typeof data.accessToken === "string" &&
    typeof data.tenantId === "string"
  ) {
    connect(data.accessToken, data.tenantId);
  }
});
if (window.opener)
  window.opener.postMessage({ type: "v79-pos-ready" }, hubOrigin);
const params = new URLSearchParams(location.hash.replace(/^#/, ""));
async function connectCookie() {
  state.token = '';
  state.demo = false;
  state.me = await api('/v1/me');
  state.tenant = state.me.tenantId;
  await load();
  render();
}
if (params.has('ticket')) {
  const ticket = params.get('ticket');
  history.replaceState(null, "", location.pathname + location.search);
  renderLogin();
  fetch('/auth/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }), cache: 'no-store' })
    .then(async response => { if (!response.ok) throw Error((await response.json().catch(() => ({}))).error || 'Hub launch failed'); return connectCookie(); })
    .catch(error => { renderLogin(); toast(`${error.message} Open POS from Hub again.`, true); });
} else {
  renderLogin();
  connectCookie().catch(() => renderLogin());
}
document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === "connect-form") {
    const v = new FormData(form);
    return connect(String(v.get("token") || ""), String(v.get("tenant") || ""));
  }
  if (state.busy) return;
  state.busy = true;
  const button = form.querySelector("[type=submit]");
  if (button) button.disabled = true;
  const v = new FormData(form);
  try {
    let result;
    switch (form.id) {
      case "product-form":
        result = await api("/v1/products", {
          method: "POST",
          body: JSON.stringify({
            name: v.get("name"),
            category: v.get("category") || undefined,
            productType: v.get("kind") || "STANDARD",
            variants: [
              {
                sku: v.get("sku"),
                name: "Standard",
                sellPrice: Number(v.get("price")),
                baseCost: Number(v.get("cost") || 0),
                taxRate: Number(v.get("tax") || 0) / 100,
                trackStock:
                  v.get("kind") === "SERVICE" ? false : v.has("trackStock"),
              },
            ],
          }),
        });
        break;
      case "customer-form":
        result = await api("/v1/customers", {
          method: "POST",
          body: JSON.stringify({
            name: v.get("name"),
            email: v.get("email") || undefined,
            phone: v.get("phone") || undefined,
            marketingConsent: v.has("marketingConsent"),
          }),
        });
        break;
      case "supplier-form":
        result = await api("/v1/suppliers", {
          method: "POST",
          body: JSON.stringify({
            name: v.get("name"),
            email: v.get("email") || undefined,
            phone: v.get("phone") || undefined,
            quotedLeadDays: Number(v.get("lead") || 0),
          }),
        });
        break;
      case "supplier-link-form":
        result = await api(
          `/v1/suppliers/${encodeURIComponent(v.get("supplierId"))}/products`,
          {
            method: "POST",
            body: JSON.stringify({
              productVariantId: v.get("variantId"),
              unitCost: Number(v.get("cost")),
              minimumOrderQty: Number(v.get("moq")),
              casePack: Number(v.get("casePack")),
              preferred: v.has("preferred"),
            }),
          },
        );
        break;
      case "purchase-order-form":
        result = await api("/v1/purchase-orders", {
          method: "POST",
          body: JSON.stringify({
            supplierId: v.get("supplierId"),
            shipToLocationId: v.get("locationId"),
            expectedAt: v.get("expectedAt") || undefined,
            notes: v.get("notes") || undefined,
            lines: [
              {
                productVariantId: v.get("variantId"),
                orderedQty: Number(v.get("quantity")),
              },
            ],
          }),
        });
        break;
      case "policy-form":
        result = await api("/v1/replenishment/policies", {
          method: "PUT",