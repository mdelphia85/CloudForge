"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive, Boxes, ChevronDown, CircleAlert, ClipboardList, FileClock, LogOut,
  MapPin, Package, Plus, RefreshCw, Search, ShieldCheck, Truck, Users, Wrench,
} from "lucide-react";

type User = { id: string; email: string; displayName: string; role: "admin" | "operator" | "viewer" };
type Item = {
  sku: string; name: string; category: string; location: string; bin: string;
  onHand: string; reorder: string; unit: string;
  state: "Healthy" | "Low stock" | "Out of stock"; updated: string;
};
type Movement = {
  type: string; quantityDelta: string; fromLocation: string | null; fromBin: string | null;
  toLocation: string | null; toBin: string | null; reference: string | null;
  createdAt: string; actorName: string;
};
type AuthStatus = { setupRequired: boolean; setupEnabled: boolean; user: User | null };

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store" });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "The request could not be completed.");
  return body;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(Number(value)));
}

export default function InventoryWorkspace() {
  const [user, setUser] = useState<User | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [setupEnabled, setSetupEnabled] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("All locations");
  const [modal, setModal] = useState<"item" | "movement" | "user" | null>(null);
  const [movementType, setMovementType] = useState("receipt");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const refreshItems = useCallback(async () => {
    const result = await requestJson<{ items: Item[] }>("/api/inventory");
    setItems(result.items);
  }, []);

  const loadSession = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const status = await requestJson<AuthStatus>("/api/auth/status");
      setSetupRequired(status.setupRequired);
      setSetupEnabled(status.setupEnabled);
      setUser(status.user);
      if (status.user) await refreshItems();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to connect to CloudForge.");
    } finally {
      setLoading(false);
    }
  }, [refreshItems]);

  useEffect(() => {
    let active = true;
    void requestJson<AuthStatus>("/api/auth/status")
      .then(async (status) => {
        if (!active) return;
        setSetupRequired(status.setupRequired);
        setSetupEnabled(status.setupEnabled);
        setUser(status.user);
        if (status.user) {
          const result = await requestJson<{ items: Item[] }>("/api/inventory");
          if (active) setItems(result.items);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Unable to connect to CloudForge.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedSku || !user) {
      return;
    }
    let active = true;
    void requestJson<{ movements: Movement[] }>(`/api/inventory/movements?sku=${encodeURIComponent(selectedSku)}`)
      .then((result) => { if (active) setMovements(result.movements); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load movement history."); });
    return () => { active = false; };
  }, [selectedSku, user]);

  const selectedItem = items.find((item) => item.sku === selectedSku) ?? null;
  const locations = useMemo(() => [...new Set(items.map((item) => item.location))].sort(), [items]);
  const visibleItems = useMemo(() => items.filter((item) =>
    `${item.name} ${item.sku} ${item.category} ${item.bin}`.toLowerCase().includes(query.toLowerCase())
    && (location === "All locations" || item.location === location)), [items, location, query]);
  const lowStock = items.filter((item) => item.state === "Low stock").length;
  const outOfStock = items.filter((item) => item.state === "Out of stock").length;
  const canWrite = user?.role !== "viewer";

  async function submitForm(event: React.FormEvent<HTMLFormElement>, endpoint: string, transform?: (data: FormData) => object) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const data = new FormData(event.currentTarget);
      const payload = transform ? transform(data) : Object.fromEntries(data.entries());
      const result = await requestJson<{ user?: User }>(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (result.user && endpoint.startsWith("/api/auth/")) {
        setUser(result.user);
        if (endpoint === "/api/auth/bootstrap") setSetupRequired(false);
      }
      setModal(null);
      await refreshItems();
      if (selectedSku) {
        const history = await requestJson<{ movements: Movement[] }>(
          `/api/inventory/movements?sku=${encodeURIComponent(selectedSku)}`,
        );
        setMovements(history.movements);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request could not be completed.");
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    setSaving(true);
    try {
      await requestJson("/api/auth/logout", { method: "POST" });
      setUser(null);
      setItems([]);
      setSelectedSku(null);
      setMovements([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to sign out.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="auth-screen"><div className="auth-card"><span className="brand-mark"><Boxes size={18} /></span><p className="eyebrow">CloudForge</p><h1>Connecting to your workspace</h1><p className="subtitle">Verifying the local session and inventory service.</p></div></main>;
  }

  if (!user) {
    const bootstrap = setupRequired && setupEnabled;
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <span className="brand-mark"><Boxes size={20} /></span>
          <p className="eyebrow">CloudForge · Local deployment</p>
          <h1>{bootstrap ? "Set up your administrator" : setupRequired ? "Administrator setup is required" : "Sign in to CloudForge"}</h1>
          <p className="subtitle">
            {bootstrap
              ? "Create the first local administrator account for this installation."
              : setupRequired
                ? "Configure DATABASE_URL, apply the database migration, and set a secure BOOTSTRAP_ADMIN_TOKEN to create the first account."
                : "Use your CloudForge local account to access inventory."}
          </p>
          {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
          {(!setupRequired || bootstrap) && (
            <form onSubmit={(event) => submitForm(event, bootstrap ? "/api/auth/bootstrap" : "/api/auth/login", bootstrap
              ? (data) => Object.fromEntries(data.entries())
              : undefined)}>
              {bootstrap && <label>Bootstrap token<input required name="bootstrapToken" type="password" autoComplete="off" /></label>}
              {bootstrap && <label>Your name<input required name="displayName" minLength={2} maxLength={120} autoComplete="name" /></label>}
              <label>Email<input required name="email" type="email" maxLength={254} autoComplete="username" /></label>
              <label>Password<input required name="password" type="password" maxLength={256} autoComplete={bootstrap ? "new-password" : "current-password"} /></label>
              {bootstrap && <small className="password-hint">At least 14 characters, including uppercase, lowercase, a number, and a symbol.</small>}
              <button className="primary-button auth-submit" disabled={saving}>{saving ? "Please wait…" : bootstrap ? "Create administrator" : "Sign in"}</button>
            </form>
          )}
          {(error || (setupRequired && !setupEnabled)) && <button className="secondary-button" onClick={() => void loadSession()}><RefreshCw size={14} /> Retry connection</button>}
          <div className="auth-security"><ShieldCheck size={15} /> Passwords and sessions are managed locally. No external identity provider is required.</div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Boxes size={18} /></span><span>cloud forge</span></div>
        <div className="workspace-switcher"><span className="workspace-dot" /><span>Inventory workspace</span><ChevronDown size={14} /></div>
        <nav className="main-nav" aria-label="Main navigation">
          <p className="nav-label">Available</p>
          <button className="nav-item active"><Package size={17} /><span>Inventory</span><span className="nav-count">{items.length}</span></button>
          <p className="nav-label nav-label-spaced">Planned modules</p>
          {[["Purchasing", ClipboardList], ["Work orders", Wrench], ["Locations", MapPin], ["Field service", Truck]].map(([label, Icon]) => (
            <button className="nav-item" key={label as string} disabled title="Not connected to backend yet">
              <Icon size={17} /><span>{label as string}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="user-avatar">{user.displayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</div>
          <div><strong>{user.displayName}</strong><span>{user.role}</span></div>
          <button className="icon-button" aria-label="Sign out" onClick={() => void signOut()} disabled={saving}><LogOut size={15} /></button>
        </div>
      </aside>
      <section className="content-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Operations</span><span>/</span><strong>Inventory</strong></div>
          <div className="topbar-actions">
            <span className="sync-status"><i />Connected</span>
            {user.role === "admin" && <button className="secondary-button compact-button" onClick={() => { setError(""); setModal("user"); }}><Users size={15} /> Add user</button>}
            <button className="icon-button" aria-label="Refresh inventory" onClick={() => void refreshItems().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Refresh failed."))}><RefreshCw size={17} /></button>
            <button className="icon-button mobile-signout" aria-label="Sign out" onClick={() => void signOut()} disabled={saving}><LogOut size={15} /></button>
          </div>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div><p className="eyebrow">Inventory control / Live records</p><h1>Inventory overview</h1><p className="subtitle">Stock balances, movements, and locations from the connected database.</p></div>
            {canWrite && <button className="primary-button" onClick={() => { setError(""); setModal("item"); }}><Plus size={17} /> Add item</button>}
          </div>
          {error && <div className="form-error page-error" role="alert"><CircleAlert size={16} />{error}</div>}
          <section className="metric-grid" aria-label="Inventory summary">
            <Metric icon={<Package size={17} />} label="Stock records" value={items.length.toLocaleString()} note="Location and bin balances" color="blue" />
            <Metric icon={<Archive size={17} />} label="Unique items" value={new Set(items.map((item) => item.sku)).size.toLocaleString()} note="Active inventory SKUs" color="green" />
            <Metric icon={<CircleAlert size={17} />} label="Low stock" value={lowStock.toLocaleString()} note="At or below reorder point" color="amber" />
            <Metric icon={<FileClock size={17} />} label="Out of stock" value={outOfStock.toLocaleString()} note="Current recorded balance is zero" color="purple" />
          </section>
          <section className="inventory-section">
            <div className="section-heading"><div><h2>Stock levels</h2><p>Filter persisted quantities by item, SKU, category, or location.</p></div><span className="audit-note"><ShieldCheck size={14} /> Changes are audited</span></div>
            <div className="table-toolbar">
              <div className="search-wrap"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, SKU, category, or bin" aria-label="Search inventory" /></div>
              <select value={location} onChange={(event) => setLocation(event.target.value)} aria-label="Filter by location">
                <option>All locations</option>{locations.map((value) => <option key={value}>{value}</option>)}
              </select>
            </div>
            <div className="table-scroll"><table>
              <thead><tr><th>Item</th><th>Category</th><th>Location / bin</th><th>On hand</th><th>Status</th><th>Updated</th></tr></thead>
              <tbody>{visibleItems.map((item) => (
                <tr className={selectedSku === item.sku ? "row-selected" : ""} key={`${item.sku}-${item.location}-${item.bin}`} onClick={() => { setMovements([]); setSelectedSku(item.sku); setError(""); }}>
                  <td><div className="item-cell"><span className="item-thumb"><Package size={17} /></span><div><strong>{item.name}</strong><span>{item.sku}</span></div></div></td>
                  <td><span className="category-tag">{item.category}</span></td>
                  <td><div className="location-cell"><span>{item.location}</span><small>{item.bin}</small></div></td>
                  <td><strong>{Number(item.onHand).toLocaleString()}</strong> <span className="unit">{item.unit}</span><small className="reorder-line">reorder at {Number(item.reorder).toLocaleString()}</small></td>
                  <td><span className={`status ${item.state.toLowerCase().replaceAll(" ", "-")}`}><i />{item.state}</span></td>
                  <td className="updated">{formatTime(item.updated)}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {visibleItems.length === 0 && <div className="empty-state"><Search size={20} /><strong>{items.length ? "No items found" : "No inventory records yet"}</strong><span>{items.length ? "Try another search or location." : canWrite ? "Add an item to start recording stock." : "Ask an administrator or operator to add stock."}</span></div>}
            <div className="table-footer"><span>Showing {visibleItems.length} of {items.length} stock records</span><span>Values reflect the latest committed database state.</span></div>
          </section>
          <section className="inventory-footnote"><ShieldCheck size={16} /><div><strong>Operational changes require an authorized user</strong><span>Receipts, issues, transfers, and counts are recorded with an actor and immutable movement history. Offline writes are not enabled in this phase.</span></div></section>
        </div>
      </section>

      {selectedItem && <aside className="detail-drawer" aria-label="Inventory item details">
        <button className="modal-close drawer-close" onClick={() => { setSelectedSku(null); setMovements([]); }} aria-label="Close item details">×</button>
        <p className="eyebrow">Inventory item</p><h2>{selectedItem.name}</h2><span className="detail-sku">{selectedItem.sku}</span>
        <div className="detail-facts"><span>Category<strong>{selectedItem.category}</strong></span><span>Location<strong>{selectedItem.location}</strong></span><span>Bin<strong>{selectedItem.bin}</strong></span><span>On hand<strong>{selectedItem.onHand} {selectedItem.unit}</strong></span><span>Reorder point<strong>{selectedItem.reorder} {selectedItem.unit}</strong></span></div>
        {canWrite && <div className="drawer-actions"><button className="primary-button" onClick={() => { setMovementType("receipt"); setModal("movement"); }}><Plus size={15} /> Record movement</button></div>}
        <div className="movement-history"><h3>Movement history</h3>{movements.length ? movements.map((movement, index) => (
          <article className="movement-entry" key={`${movement.createdAt}-${index}`}>
            <strong>{movement.type} · {Number(movement.quantityDelta) > 0 ? "+" : ""}{movement.quantityDelta} {selectedItem.unit}</strong>
            <span>{movement.fromLocation ? `${movement.fromLocation} / ${movement.fromBin}` : "—"} → {movement.toLocation ? `${movement.toLocation} / ${movement.toBin}` : "—"}</span>
            <small>{movement.actorName} · {formatTime(movement.createdAt)}{movement.reference ? ` · ${movement.reference}` : ""}</small>
          </article>
        )) : <p className="empty-history">No movements recorded for this item.</p>}</div>
      </aside>}
      {selectedItem && <button className="drawer-backdrop" aria-label="Close item details" onClick={() => { setSelectedSku(null); setMovements([]); }} />}

      {modal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div className="modal-heading"><div><p className="eyebrow">{modal === "item" ? "Inventory master" : modal === "user" ? "Local accounts" : "Inventory movement"}</p><h2 id="modal-title">{modal === "item" ? "Add an item" : modal === "user" ? "Create local account" : "Record stock movement"}</h2></div><button className="modal-close" onClick={() => setModal(null)} aria-label="Close dialog">×</button></div>
          {modal === "item" && <form onSubmit={(event) => submitForm(event, "/api/inventory")}>
            <div className="form-grid">
              <label>Item name<input name="name" required maxLength={200} /></label>
              <label>SKU<input name="sku" required maxLength={64} /></label>
              <label>Category<input name="category" required maxLength={100} /></label>
              <label>Unit<input name="unit" required maxLength={32} placeholder="ea, ft, kg..." /></label>
              <label>Location<input name="location" required maxLength={160} /></label>
              <label>Bin<input name="bin" required maxLength={100} /></label>
              <label>Opening quantity<input name="onHand" required type="number" min="0" step="0.001" defaultValue="0" /></label>
              <label>Reorder point<input name="reorder" required type="number" min="0" step="0.001" defaultValue="0" /></label>
            </div><FormActions saving={saving} onCancel={() => setModal(null)} />
          </form>}
          {modal === "movement" && <form onSubmit={(event) => submitForm(event, "/api/inventory/movements", (data) => ({
            type: data.get("type"),
            sku: selectedItem?.sku,
            quantity: data.get("quantity"),
            location: data.get("location"),
            bin: data.get("bin"),
            sourceLocation: data.get("sourceLocation"),
            sourceBin: data.get("sourceBin"),
            destinationLocation: data.get("destinationLocation"),
            destinationBin: data.get("destinationBin"),
            reference: data.get("reference"),
            idempotencyKey: crypto.randomUUID(),
          }))}>
            <div className="form-grid">
              <label>Movement type<select name="type" value={movementType} onChange={(event) => setMovementType(event.target.value)}><option value="receipt">Receipt</option><option value="issue">Issue</option><option value="transfer">Transfer</option><option value="count">Cycle count</option></select></label>
              {movementType !== "count" && <label>Quantity<input name="quantity" required type="number" min="0.001" step="0.001" /></label>}
              {movementType === "count" && <label>Counted quantity<input name="quantity" required type="number" min="0" step="0.001" /></label>}
              {(movementType === "receipt" || movementType === "count") && <><label>Location<input name="location" required defaultValue={selectedItem?.location} /></label><label>Bin<input name="bin" required defaultValue={selectedItem?.bin} /></label></>}
              {(movementType === "issue" || movementType === "transfer") && <><label>Source location<input name="sourceLocation" required defaultValue={selectedItem?.location} /></label><label>Source bin<input name="sourceBin" required defaultValue={selectedItem?.bin} /></label></>}
              {movementType === "transfer" && <><label>Destination location<input name="destinationLocation" required /></label><label>Destination bin<input name="destinationBin" required /></label></>}
              <label className="form-full">Reference or reason<input name="reference" maxLength={160} placeholder="Work order, PO, or count reference" /></label>
            </div><p className="workflow-note"><ShieldCheck size={15} /> The stock change and audit history are saved together in one database transaction.</p>
            <FormActions saving={saving} onCancel={() => setModal(null)} />
          </form>}
          {modal === "user" && <form onSubmit={(event) => submitForm(event, "/api/users")}>
            <div className="form-grid">
              <label>Name<input name="displayName" required minLength={2} maxLength={120} /></label>
              <label>Email<input name="email" required type="email" maxLength={254} /></label>
              <label>Role<select name="role"><option value="operator">Operator</option><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label>
              <label>Password<input name="password" required type="password" minLength={14} maxLength={256} autoComplete="new-password" /></label>
            </div><p className="password-hint">At least 14 characters, including uppercase, lowercase, a number, and a symbol.</p>
            <FormActions saving={saving} onCancel={() => setModal(null)} />
          </form>}
          {error && <div className="form-error modal-error" role="alert"><CircleAlert size={16} />{error}</div>}
        </section>
      </div>}
    </main>
  );
}

function Metric({ icon, label, value, note, color }: { icon: React.ReactNode; label: string; value: string; note: string; color: string }) {
  return <div className="metric-card"><span className={`metric-icon ${color}`}>{icon}</span><div><span className="metric-label">{label}</span><strong>{value}</strong><small>{note}</small></div></div>;
}

function FormActions({ saving, onCancel }: { saving: boolean; onCancel: () => void }) {
  return <div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save"}</button></div>;
}
