"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { formatDisplayLabel } from "@/lib/display-label";

type Row = Record<string, unknown>;
type User = { id: string; displayName: string; role: "admin" | "operator" | "viewer" };
type Tab = "purchasing" | "engineering" | "projects" | "production" | "service";

const tabs: { id: Tab; label: string }[] = [
  { id: "purchasing", label: "Inventory & Purchasing" },
  { id: "engineering", label: "Engineering Control" },
  { id: "projects", label: "Project Planning" },
  { id: "production", label: "Production Floor" },
  { id: "service", label: "Field Service" },
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store" });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "The request could not be completed.");
  return result;
}

function value(row: Row, key: string): string {
  const item = row[key];
  if (item === undefined || item === null || item === "") return "—";
  if (typeof item === "string" && /^\d{4}-\d\d-\d\dT/.test(item)) return new Date(item).toLocaleString();
  return String(item);
}

function Panel({ children, title }: { children: ReactNode; title: string }) {
  return <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
    <h2 className="mb-4 text-base font-bold text-slate-800">{title}</h2>{children}
  </section>;
}

function TextField({ label, name, type = "text", required = false, min, max, step, defaultValue }: {
  label: string; name: string; type?: string; required?: boolean; min?: string; max?: string; step?: string; defaultValue?: string;
}) {
  return <label className="block text-xs font-semibold text-slate-700">
    <span className="mb-1 block">{label}{required ? " *" : ""}</span>
    <input name={name} type={type} required={required} min={min} max={max} step={step} defaultValue={defaultValue}
      className="h-10 w-full rounded-md border border-slate-300 px-2 text-sm"/>
  </label>;
}

function SelectField({ label, name, options, required = false, defaultValue = "" }: {
  label: string; name: string; options: { value: string; label: string }[]; required?: boolean; defaultValue?: string;
}) {
  return <label className="block text-xs font-semibold text-slate-700">
    <span className="mb-1 block">{label}{required ? " *" : ""}</span>
    <select name={name} required={required} defaultValue={defaultValue}
      className="h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm">
      {!required && <option value="">None</option>}
      {required && <option value="">Select…</option>}
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

function Submit({ children = "Save" }: { children?: ReactNode }) {
  return <button className="rounded-md bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800">
    {children}
  </button>;
}

function Table({ rows, columns, actions }: {
  rows: Row[]; columns: [string, string][]; actions?: (row: Row) => ReactNode;
}) {
  return <div className="overflow-x-auto">
    <table className="w-full text-left text-xs">
      <thead><tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500">
        {columns.map(([key, label]) => <th key={key} className="whitespace-nowrap px-3 py-2">{label}</th>)}
        {actions && <th className="px-3 py-2">Actions</th>}
      </tr></thead>
      <tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)} className="border-b border-slate-100">
        {columns.map(([key]) => <td key={key} className="whitespace-nowrap px-3 py-2">{key === "kind" || key === "linkType" ? formatDisplayLabel(value(row, key)) : value(row, key)}</td>)}
        {actions && <td className="px-3 py-2">{actions(row)}</td>}
      </tr>)}
      {!rows.length && <tr><td colSpan={columns.length + (actions ? 1 : 0)} className="px-3 py-6 text-center text-slate-500">No records yet.</td></tr>}
      </tbody>
    </table>
  </div>;
}

export default function Phase3Workspace() {
  const [user, setUser] = useState<User | null>(null);
  const [overview, setOverview] = useState<Record<string, Row[]>>({});
  const [inventory, setInventory] = useState<Row[]>([]);
  const [team, setTeam] = useState<Row[]>([]);
  const [suppliers, setSuppliers] = useState<Row[]>([]);
  const [orders, setOrders] = useState<Row[]>([]);
  const [reservations, setReservations] = useState<Row[]>([]);
  const [shortages, setShortages] = useState<Row[]>([]);
  const [boms, setBoms] = useState<Row[]>([]);
  const [changes, setChanges] = useState<Row[]>([]);
  const [approvedRevisions, setApprovedRevisions] = useState<Row[]>([]);
  const [production, setProduction] = useState<{ workCenters: Row[]; shifts: Row[]; assignments: Row[]; downtime: Row[] }>({
    workCenters: [], shifts: [], assignments: [], downtime: [],
  });
  const [projectId, setProjectId] = useState("");
  const [planning, setPlanning] = useState<Record<string, unknown> | null>(null);
  const [serviceId, setServiceId] = useState("");
  const [service, setService] = useState<Record<string, unknown> | null>(null);
  const [tab, setTab] = useState<Tab>("purchasing");
  const [lineCount, setLineCount] = useState(1);
  const [bomLineCount, setBomLineCount] = useState(1);
  const [changeLinkType, setChangeLinkType] = useState<"bomRevision" | "document" | "asset" | "productionJob">("bomRevision");
  const [dependencyType, setDependencyType] = useState<"task" | "milestone">("task");
  const [reservationKind, setReservationKind] = useState<"project" | "production_job" | "field_service_job">("project");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const [data, optionData, supplierData, orderData, reserveData, shortageData, bomData, changeData, revisionData, floorData] = await Promise.all([
      api<Record<string, Row[]>>("/api/operations/overview"),
      api<{ users: Row[]; items: Row[] }>("/api/operations/phase3/options"),
      api<{ suppliers: Row[] }>("/api/operations/suppliers"),
      api<{ purchaseOrders: Row[] }>("/api/operations/purchase-orders"),
      api<{ reservations: Row[] }>("/api/operations/reservations"),
      api<{ shortages: Row[] }>("/api/operations/material-shortages"),
      api<{ revisions: Row[] }>("/api/operations/engineering/bom-revisions"),
      api<{ changeOrders: Row[] }>("/api/operations/engineering/change-orders"),
      api<{ revisions: Row[] }>("/api/operations/engineering/approved-revisions"),
      api<typeof production>("/api/operations/production/resources"),
    ]);
    setOverview(data);
    setInventory(optionData.items);
    setTeam(optionData.users);
    setSuppliers(supplierData.suppliers);
    setOrders(orderData.purchaseOrders);
    setReservations(reserveData.reservations);
    setShortages(shortageData.shortages);
    setBoms(bomData.revisions);
    setChanges(changeData.changeOrders);
    setApprovedRevisions(revisionData.revisions);
    setProduction(floorData);
  }, []);

  useEffect(() => {
    let active = true;
    void api<{ user: User | null }>("/api/auth/status").then(async (result) => {
      if (!active) return;
      setUser(result.user);
      if (result.user) await refresh();
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Unable to load the workspace.");
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    void api<Record<string, unknown>>(`/api/operations/projects/${projectId}/planning`)
      .then((result) => { if (active) setPlanning(result); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load project planning."); });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    if (!serviceId) return;
    let active = true;
    void api<Record<string, unknown>>(`/api/operations/service/${serviceId}/worklog`)
      .then((result) => { if (active) setService(result); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load service history."); });
    return () => { active = false; };
  }, [serviceId]);

  const projects = overview.projects ?? [];
  const items = inventory;
  const jobs = overview.production ?? [];
  const serviceJobs = (overview.service ?? []).filter((row) => user?.role !== "viewer" || row.assigned_to === user.id);
  const users = team;
  const assets = overview.assets ?? [];
  const canEdit = user?.role === "admin" || user?.role === "operator";

  async function mutate<T>(url: string, body: Record<string, unknown>, success: string, method = "POST"): Promise<T | undefined> {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<T>(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await refresh();
      if (projectId) {
        setPlanning(await api<Record<string, unknown>>(`/api/operations/projects/${projectId}/planning`));
      }
      if (serviceId) {
        setService(await api<Record<string, unknown>>(`/api/operations/service/${serviceId}/worklog`));
      }
      setNotice(success);
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request could not be completed.");
      return undefined;
    } finally { setBusy(false); }
  }

  async function sendForm(event: FormEvent<HTMLFormElement>, url: string, success: string, build?: (data: FormData) => Record<string, unknown>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const data = new FormData(formElement);
    const body = build ? build(data) : Object.fromEntries([...data.entries()].filter(([, entry]) => entry !== ""));
    const result = await mutate(url, body, success);
    if (result) formElement.reset();
  }

  const projectOptions = projects.map((row) => ({ value: String(row.id), label: `${value(row, "code")} · ${value(row, "name")}` }));
  const itemOptions = items.map((row) => ({ value: String(row.sku), label: `${value(row, "sku")} · ${value(row, "name")}` }));
  const userOptions = users.map((row) => ({ value: String(row.id), label: String(row.display_name ?? row.displayName ?? row.email) }));
  const jobOptions = jobs.map((row) => ({ value: String(row.id), label: `${value(row, "job_code")} · ${value(row, "title")}` }));
  const serviceOptions = serviceJobs.map((row) => ({ value: String(row.id), label: `${value(row, "asset_tag")} · ${value(row, "title")}` }));

  if (!user) return <main className="min-h-screen bg-slate-100 p-8 text-slate-800">
    <section className="mx-auto max-w-lg rounded-xl bg-white p-8 text-center shadow">
      <h1 className="text-xl font-bold">CloudForge Phase 3</h1>
      <p className="my-4 text-sm text-slate-600">{error || "Sign in to access integrated manufacturing workflows."}</p>
      <Link href="/" className="text-teal-700 underline">Go to sign in</Link>
    </section>
  </main>;

  return <main className="min-h-screen bg-[#f4f6f5] text-slate-800">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b bg-white px-5 py-5 lg:px-10">
      <div><p className="text-[10px] font-bold uppercase tracking-widest text-teal-700">CloudForge · Manufacturing Change Control</p>
        <h1 className="text-2xl font-bold">Phase 3 Operations</h1>
        <p className="mt-1 text-xs text-slate-500">Live shared records · {user.displayName} · {user.role}</p></div>
      <div className="flex gap-3"><Link href="/operations" className="rounded-md border px-3 py-2 text-xs font-semibold">Phase 1/2 workspace</Link>
        <Link href="/operations/equipment" className="rounded-md border px-3 py-2 text-xs font-semibold">Phase 4 equipment</Link>
        <button disabled={busy} onClick={() => void refresh()} className="rounded-md bg-slate-800 px-3 py-2 text-xs font-semibold text-white">Refresh data</button></div>
    </header>
    <div className="mx-auto max-w-[1600px] space-y-5 p-5 lg:p-8">
      <nav className="flex flex-wrap gap-2" aria-label="Phase 3 areas">
        {tabs.map((item) => <button key={item.id} onClick={() => { setTab(item.id); setError(""); setNotice(""); }}
          className={`rounded-md px-4 py-2 text-xs font-semibold ${tab === item.id ? "bg-teal-800 text-white" : "border bg-white text-slate-700"}`}>
          {item.label}</button>)}
      </nav>
      {error && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
      {notice && <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}

      {tab === "purchasing" && <div className="space-y-5">
        <div className="grid gap-5 xl:grid-cols-2">
          {canEdit && <Panel title="Add supplier"><form onSubmit={(event) => void sendForm(event, "/api/operations/suppliers", "Supplier added.")} className="grid gap-3 md:grid-cols-2">
            <TextField name="code" label="Supplier code" required/><TextField name="name" label="Supplier name" required/>
            <TextField name="contactName" label="Contact name"/><TextField name="email" label="Email" type="email"/>
            <TextField name="phone" label="Phone"/><TextField name="leadTimeDays" label="Lead time (days)" type="number" min="0" defaultValue="0"/>
            <div className="md:col-span-2"><Submit>Add supplier</Submit></div>
          </form></Panel>}
          {canEdit && <Panel title="Create purchase order"><form onSubmit={(event) => void sendForm(event, "/api/operations/purchase-orders", "Purchase order created.", (form) => ({
            poNumber: form.get("poNumber"), supplierId: form.get("supplierId"), projectId: form.get("projectId"),
            orderDate: form.get("orderDate"), expectedDelivery: form.get("expectedDelivery"), notes: form.get("notes"),
            lines: Array.from({ length: lineCount }, (_, index) => ({
              sku: form.get(`sku${index}`), quantity: form.get(`quantity${index}`), unitPrice: form.get(`unitPrice${index}`),
              projectId: form.get(`lineProject${index}`),
            })),
          }))} className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2"><TextField name="poNumber" label="PO number" required/>
              <SelectField name="supplierId" label="Supplier" options={suppliers.map((row) => ({ value: String(row.id), label: String(row.name) }))} required/>
              <SelectField name="projectId" label="Project" options={projectOptions}/>
              <TextField name="expectedDelivery" label="Expected delivery" type="date"/>
            </div>
            {Array.from({ length: lineCount }, (_, index) => <div key={index} className="grid gap-3 rounded-md border p-3 md:grid-cols-4">
              <SelectField name={`sku${index}`} label={`Line ${index + 1} · SKU`} options={itemOptions} required/>
              <TextField name={`quantity${index}`} label="Ordered quantity" type="number" min="0.001" step="0.001" required/>
              <TextField name={`unitPrice${index}`} label="Unit price" type="number" min="0" step="0.0001" defaultValue="0"/>
              <SelectField name={`lineProject${index}`} label="Line project override" options={projectOptions}/>
            </div>)}
            <div className="flex flex-wrap gap-2"><button type="button" onClick={() => setLineCount((count) => Math.min(count + 1, 20))} className="rounded border px-3 py-2 text-xs">Add line</button>
              <Submit>Create purchase order</Submit></div>
          </form></Panel>}
        </div>
        <Panel title="Suppliers"><Table rows={suppliers} columns={[["code","Code"],["name","Name"],["email","Email"],["phone","Phone"],["leadTimeDays","Lead time"],["isActive","Active"]]}/></Panel>
        <Panel title="Purchase orders and receiving"><div className="space-y-5">{orders.map((order) => {
          const lines = Array.isArray(order.lines) ? order.lines as Row[] : [];
          const status = String(order.status);
          return <div key={String(order.id)} className="rounded-lg border border-slate-200 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
              <strong>{value(order, "poNumber")} · {value(order, "supplierName")}</strong><span className="rounded bg-slate-100 px-2 py-1 text-xs">{status}</span>
              <span className="text-xs text-slate-500">{value(order, "projectCode")} · ETA {value(order, "expectedDelivery")}</span>
              {canEdit && status === "draft" && <button onClick={() => void mutate(`/api/operations/purchase-orders/${order.id}/status`, { status: "submitted" }, "Order submitted.")} className="text-teal-700 underline">Submit</button>}
              {canEdit && status === "submitted" && <button onClick={() => void mutate(`/api/operations/purchase-orders/${order.id}/status`, { status: "ordered" }, "Order marked ordered.")} className="text-teal-700 underline">Mark ordered</button>}
            </div>
            {lines.map((line) => <div key={String(line.id)} className="grid gap-3 border-t py-3 text-xs md:grid-cols-6">
              <span>{value(line, "sku")} · {value(line, "itemName")}</span>
              <span>Ordered {value(line, "orderedQty")}</span><span>Received {value(line, "receivedQty")}</span>
              {canEdit && ["submitted", "ordered", "partially_received"].includes(status) &&
                <form onSubmit={(event) => void sendForm(event, `/api/operations/purchase-orders/${order.id}/receive`, "Receipt posted to inventory.", (form) => ({
                  lineId: line.id, quantity: form.get("quantity"), location: form.get("location"), bin: form.get("bin"),
                    idempotencyKey: crypto.randomUUID(), authorizeOverage: form.get("authorizeOverage") === "on",
                }))} className="grid gap-2 md:col-span-3 md:grid-cols-4">
                  <input name="quantity" type="number" step="0.001" min="0.001" required placeholder="Receive qty" className="rounded border px-2 py-1"/>
                  <input name="location" required placeholder="Location" className="rounded border px-2 py-1"/>
                  <input name="bin" required placeholder="Bin" className="rounded border px-2 py-1"/>
                    {user.role === "admin" && <label className="flex items-center gap-1"><input name="authorizeOverage" type="checkbox"/>Authorize overage</label>}
                  <Submit>Receive</Submit>
                </form>}
            </div>)}
          </div>;
        })}{!orders.length && <p className="text-sm text-slate-500">No purchase orders recorded.</p>}</div></Panel>
        <div className="grid gap-5 xl:grid-cols-2">
          {canEdit && <Panel title="Reserve inventory"><form onSubmit={(event) => void sendForm(event, "/api/operations/reservations", "Inventory reserved.", (form) => ({
            sku: form.get("sku"), quantity: form.get("quantity"), location: form.get("location"), bin: form.get("bin"),
            idempotencyKey: crypto.randomUUID(), target: { kind: form.get("targetKind"), id: form.get("targetId") },
          }))} className="grid gap-3 md:grid-cols-2">
            <SelectField name="sku" label="Inventory item" options={itemOptions} required/>
            <TextField name="quantity" label="Quantity" type="number" min="0.001" step="0.001" required/>
            <TextField name="location" label="Location" required/><TextField name="bin" label="Bin" required/>
            <label className="block text-xs font-semibold text-slate-700"><span className="mb-1 block">Reserve for</span><select name="targetKind" value={reservationKind}
              onChange={(event) => setReservationKind(event.target.value as "project" | "production_job" | "field_service_job")}
              className="h-10 w-full rounded-md border bg-white px-2 text-sm">
              <option value="project">Project</option><option value="production_job">Production job</option>
              <option value="field_service_job">Field-service job</option>
            </select></label>
            <SelectField name="targetId" label="Target record" required options={
              reservationKind === "project" ? projectOptions : reservationKind === "production_job" ? jobOptions : serviceOptions
            }/>
            <div className="md:col-span-2"><Submit>Reserve material</Submit></div>
          </form></Panel>}
          <Panel title="Material availability and shortages"><Table rows={shortages} columns={[
            ["projectCode","Project"],["sku","SKU"],["demandStatus","Demand basis"],["bomRevisionCode","BOM revision"],
            ["requiredQty","Required"],["consumedQty","Consumed"],
            ["projectReserved","Reserved"],["onHand","On hand"],["incomingQty","Incoming"],["shortageQty","Shortage"],
          ]}/></Panel>
        </div>
        <Panel title="Active reservations"><Table rows={reservations.filter((row) => row.status === "reserved")} columns={[
          ["sku","SKU"],["itemName","Item"],["quantity","Qty"],["consumedQty","Consumed"],["location","Location"],["bin","Bin"],
          ["projectCode","Project"],["jobCode","Production job"],["serviceTitle","Service job"],
        ]} actions={canEdit ? (row) => <button onClick={() => void mutate(`/api/operations/reservations/${row.id}`, {}, "Reservation released.", "DELETE")} className="text-rose-700 underline">Release</button> : undefined}/></Panel>
      </div>}

      {tab === "engineering" && <div className="space-y-5">
        {canEdit && <div className="grid gap-5 xl:grid-cols-2">
          <Panel title="Create BOM revision"><form onSubmit={(event) => void sendForm(event, "/api/operations/engineering/bom-revisions", "BOM revision drafted.", (form) => ({
            projectId: form.get("projectId"), revisionCode: form.get("revisionCode"), changeNotes: form.get("changeNotes"),
            lines: Array.from({ length: bomLineCount }, (_, index) => ({
              itemId: form.get(`bomItem${index}`), requiredQty: form.get(`bomQty${index}`), notes: form.get(`bomNotes${index}`),
            })),
          }))} className="space-y-3">
            <SelectField name="projectId" label="Project" options={projectOptions} required/>
            <TextField name="revisionCode" label="Revision" required/><TextField name="changeNotes" label="Change notes"/>
            {Array.from({ length: bomLineCount }, (_, index) => <div key={index} className="grid gap-3 md:grid-cols-3">
              <SelectField name={`bomItem${index}`} label={`Line ${index + 1} · Inventory item`} options={items.map((item) => ({
                value: String(item.id), label: `${value(item, "sku")} · ${value(item, "name")}`,
              }))} required/>
              <TextField name={`bomQty${index}`} label="Required quantity" type="number" min="0.001" step="0.001" required/>
              <TextField name={`bomNotes${index}`} label="Line notes"/>
            </div>)}
            <div className="flex gap-2"><button type="button" onClick={() => setBomLineCount((count) => Math.min(count + 1, 100))} className="rounded border px-3 py-2 text-xs">Add line</button>
              <Submit>Create draft</Submit></div>
          </form></Panel>
          <Panel title="Create engineering change order"><form onSubmit={(event) => void sendForm(event, "/api/operations/engineering/change-orders", "Change order created.", (form) => {
            const type = form.get("linkType");
            const linkedId = form.get("linkId");
            return {
              changeNumber: form.get("changeNumber"), projectId: form.get("projectId"), assetId: form.get("assetId"),
              title: form.get("title"), reason: form.get("reason"), changeSummary: form.get("changeSummary"),
              implementationNotes: form.get("implementationNotes"),
              links: type && linkedId ? [{ type, id: linkedId }] : [],
            };
          })} className="grid gap-3 md:grid-cols-2">
            <TextField name="changeNumber" label="Change number" required/><SelectField name="projectId" label="Project" options={projectOptions} required/>
            <SelectField name="assetId" label="Equipment" options={assets.map((asset) => ({ value: String(asset.id), label: `${value(asset, "asset_tag")} · ${value(asset, "name")}` }))}/>
            <TextField name="title" label="Title" required/><TextField name="reason" label="Reason" required/>
            <TextField name="changeSummary" label="Change summary"/><TextField name="implementationNotes" label="Implementation notes"/>
            <label className="block text-xs font-semibold text-slate-700"><span className="mb-1 block">Link a record</span>
              <select name="linkType" value={changeLinkType} onChange={(event) => setChangeLinkType(event.target.value as typeof changeLinkType)}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm">
                <option value="bomRevision">BOM revision</option><option value="document">Engineering document</option>
                <option value="asset">Equipment</option><option value="productionJob">Production job</option>
              </select>
            </label>
            <SelectField name="linkId" label="Linked record" options={
              changeLinkType === "bomRevision" ? boms.map((row) => ({
                value: String(row.id), label: `${value(row, "projectCode")} · BOM ${value(row, "revisionCode")}`,
              })) : changeLinkType === "document" ? (overview.documents ?? []).map((row) => ({
                value: String(row.id), label: `${value(row, "project_code")} · ${value(row, "title")}`,
              })) : changeLinkType === "asset" ? assets.map((row) => ({
                value: String(row.id), label: `${value(row, "project_code")} · ${value(row, "asset_tag")}`,
              })) : jobs.map((row) => ({
                value: String(row.id), label: `${value(row, "project_code")} · ${value(row, "job_code")}`,
              }))
            }/>
            <div className="md:col-span-2"><Submit>Create change order</Submit></div>
          </form></Panel>
        </div>}
        <Panel title="BOM revision lifecycle"><Table rows={boms} columns={[
          ["projectCode","Project"],["revisionCode","Revision"],["status","Status"],["changeNotes","Change notes"],["createdBy","Created by"],["approvedAt","Approved"],
        ]} actions={(row) => {
          const action = row.status === "draft" ? "submit" : row.status === "review" && user.role === "admin" ? "approve" : "";
          return <div className="flex items-start gap-3">
            {canEdit && action ? <button onClick={() => void mutate(`/api/operations/engineering/bom-revisions/${row.id}/status`, { action }, `BOM ${action === "submit" ? "submitted" : "approved"}.`)} className="text-teal-700 underline">{action}</button> : null}
            <details><summary className="cursor-pointer text-teal-700">Lines</summary>
              <Table rows={(row.lines as Row[]) ?? []} columns={[["sku","SKU"],["itemName","Item"],["requiredQty","Qty"],["notes","Notes"]]}/>
            </details>
          </div>;
        }}/></Panel>
        <Panel title="Engineering change approval and implementation"><Table rows={changes} columns={[
          ["changeNumber","Change"],["projectCode","Project"],["title","Title"],["status","Status"],["requestedBy","Requested by"],["approvedAt","Approved"],
        ]} actions={(row) => {
          const actions = row.status === "draft" ? ["submit"] : row.status === "review" && user.role === "admin" ?
            ["approve", "reject"] : row.status === "approved" && user.role === "admin" ? ["implement"] : [];
          const links = Array.isArray(row.links) ? row.links as Row[] : [];
          const documentLinks = links.filter((link) => link.type === "document");
          const hasDocumentRevisions = documentLinks.every((link) =>
            approvedRevisions.some((revision) => revision.documentId === link.id),
          );
          return <div className="space-y-2">
            {canEdit && actions.filter((action) => action !== "implement").map((action) => <button key={action} onClick={() => void mutate(
              `/api/operations/engineering/change-orders/${row.id}/action`, { action },
              `Change ${action === "submit" ? "submitted" : action === "implement" ? "implemented" : action === "approve" ? "approved" : "rejected"}.`,
            )} className="mr-2 text-teal-700 underline">{action}</button>)}
            {canEdit && actions.includes("implement") && <form onSubmit={(event) => void sendForm(
              event,
              `/api/operations/engineering/change-orders/${row.id}/action`,
              "Change implementation evidence recorded.",
              (form) => ({
                action: "implement",
                notes: form.get("verificationNotes"),
                documentRevisions: documentLinks.map((link) => ({
                  linkId: link.linkId,
                  revisionId: form.get(`revision-${String(link.linkId)}`),
                })),
              }),
            )} className="space-y-2 rounded border border-slate-200 p-2">
              {documentLinks.map((link) => {
                const revisions = approvedRevisions.filter((revision) => revision.documentId === link.id);
                return revisions.length ? <SelectField
                  key={String(link.linkId)}
                  name={`revision-${String(link.linkId)}`}
                  label={`Approved revision · ${value(link, "documentTitle")}`}
                  required
                  options={revisions.map((revision) => ({
                    value: String(revision.id),
                    label: `Rev ${value(revision, "revision")} · ${value(revision, "fileName")}`,
                  }))}
                /> : <p key={String(link.linkId)} className="text-xs text-amber-700">
                  No approved revision is available for {value(link, "documentTitle")}; approve one before implementation.
                </p>;
              })}
              <label className="block text-xs font-semibold text-slate-700">
                <span className="mb-1 block">Verification and implementation notes *</span>
                <textarea name="verificationNotes" required maxLength={2000} rows={3}
                  className="w-full rounded-md border border-slate-300 p-2 text-sm"/>
              </label>
              <p className="text-xs text-slate-500">This records verified revision and site evidence; it does not program physical controllers.</p>
              {hasDocumentRevisions && <Submit>Record evidence and implement</Submit>}
            </form>}
            <details><summary className="cursor-pointer text-teal-700">Details / approval history</summary>
              <div className="min-w-[320px] space-y-2 p-2 text-xs">
                <p><strong>Reason:</strong> {value(row, "reason")}</p>
                <p><strong>What changed:</strong> {value(row, "changeSummary")}</p>
                <p><strong>Implementation:</strong> {value(row, "implementationNotes")}</p>
                <p><strong>Linked records:</strong> {links.map((link) => `${formatDisplayLabel(value(link, "type"))} ${value(link, "id")}`).join(", ") || "—"}</p>
                <Table rows={(row.approvals as Row[]) ?? []} columns={[["action","Action"],["actorName","Actor"],["notes","Notes"],["createdAt","Date"]]}/>
                <Table rows={(row.implementationEvidence as Row[]) ?? []} columns={[
                  ["linkType","Record type"],["documentTitle","Document"],["revision","Document revision"],
                  ["bomRevisionCode","BOM revision"],["notes","Verification"],["verifiedBy","Verified by"],["verifiedAt","Verified at"],
                ]}/>
              </div>
            </details>
          </div>;
        }}/></Panel>
        <p className="text-xs text-slate-500">PLC/HMI revisions, approval, downloads, and installation history remain available in the existing <Link className="text-teal-700 underline" href="/operations">Phase 2 engineering workspace</Link>.</p>
      </div>}

      {tab === "projects" && <div className="space-y-5">
        <Panel title="Select project">
          <select aria-label="Project" value={projectId} onChange={(event) => { setPlanning(null); setProjectId(event.target.value); }} className="mt-2 h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm">
            <option value="">Select a project to view planning…</option>
            {projectOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </Panel>
        {projectId && canEdit && <div className="grid gap-5 xl:grid-cols-2">
          <Panel title="Create and assign project task"><form onSubmit={(event) => void sendForm(event, `/api/operations/projects/${projectId}/planning`, "Task assigned.")} className="grid gap-3 md:grid-cols-2">
            <input type="hidden" name="action" value="task"/><TextField name="title" label="Task" required/>
            <SelectField name="discipline" label="Team" required options={[
              { value: "engineering", label: "Engineering" }, { value: "project", label: "Project" },
              { value: "production", label: "Production" }, { value: "field_service", label: "Field service" },
            ]}/>
            <SelectField name="assigneeId" label="Assignee" options={userOptions}/>
            <TextField name="dueDate" label="Due date" type="date"/><TextField name="notes" label="Instructions"/>
            <div className="md:col-span-2"><Submit>Create task</Submit></div>
          </form></Panel>
          <Panel title="Add milestone"><form onSubmit={(event) => void sendForm(event, `/api/operations/projects/${projectId}/planning`, "Milestone added.")} className="grid gap-3 md:grid-cols-2">
            <input type="hidden" name="action" value="milestone"/><TextField name="code" label="Milestone code" required/>
            <TextField name="title" label="Title" required/><TextField name="dueDate" label="Due date" type="date"/>
            <SelectField name="assigneeId" label="Assignee" options={userOptions}/><TextField name="notes" label="Notes"/>
            <div className="md:col-span-2"><Submit>Add milestone</Submit></div>
          </form></Panel>
          <Panel title="Assign project resource"><form onSubmit={(event) => void sendForm(event, `/api/operations/projects/${projectId}/planning`, "Resource assigned.", (form) => ({
            action: "resource", userId: form.get("userId"), discipline: form.get("discipline"), allocationPercent: form.get("allocationPercent"),
            startsOn: form.get("startsOn"), endsOn: form.get("endsOn"), notes: form.get("notes"),
          }))} className="grid gap-3 md:grid-cols-2">
            <SelectField name="userId" label="Team member" options={userOptions} required/><TextField name="discipline" label="Discipline" required/>
            <TextField name="allocationPercent" label="Allocation %" type="number" min="0.01" max="100" step="0.01" defaultValue="100"/>
            <TextField name="startsOn" label="Starts" type="date"/><TextField name="endsOn" label="Ends" type="date"/>
            <div className="md:col-span-2"><Submit>Assign resource</Submit></div>
          </form></Panel>
          <Panel title="Record project cost"><form onSubmit={(event) => void sendForm(event, `/api/operations/projects/${projectId}/planning`, "Cost entry added.", (form) => ({
            action: "cost", costType: form.get("costType"), description: form.get("description"), source: form.get("source"),
            unit: form.get("unit"), quantity: form.get("quantity"), estimatedUnitCost: form.get("estimatedUnitCost"),
            actualUnitCost: form.get("actualUnitCost"), sourceReference: form.get("sourceReference"),
          }))} className="grid gap-3 md:grid-cols-2">
            <SelectField name="costType" label="Cost type" options={[{ value: "material", label: "Material" }, { value: "labor", label: "Labor" }, { value: "other", label: "Other" }]} required/>
            <TextField name="description" label="Description" required/><TextField name="source" label="Source" required/>
            <TextField name="unit" label="Unit" required/><TextField name="quantity" label="Quantity" type="number" min="0.001" step="0.001" required/>
            <TextField name="estimatedUnitCost" label="Estimated unit cost" type="number" min="0" step="0.0001"/>
            <TextField name="actualUnitCost" label="Actual unit cost" type="number" min="0" step="0.0001"/>
            <TextField name="sourceReference" label="Source reference"/>
            <div className="md:col-span-2"><Submit>Record cost</Submit></div>
          </form></Panel>
          <Panel title="Add task or milestone dependency"><form onSubmit={(event) => void sendForm(event, `/api/operations/projects/${projectId}/planning`, "Dependency added.", (form) => {
            return { action: "dependency", type: form.get("type"), recordId: form.get("recordId"), dependsOnId: form.get("dependsOnId") };
          })} className="grid gap-3 md:grid-cols-2">
            <label className="block text-xs font-semibold">Dependency type<select name="type" value={dependencyType} onChange={(event) => setDependencyType(event.target.value as "task" | "milestone")} className="mt-1 h-10 w-full rounded-md border bg-white px-2 text-sm">
              <option value="task">Task</option><option value="milestone">Milestone</option>
            </select></label>
            <div/>
            <SelectField name="recordId" label="Record" options={((planning?.[dependencyType === "task" ? "tasks" : "milestones"] as Row[]) ?? []).map((row) => ({
              value: String(row.id), label: String(row.title),
            }))} required/>
            <SelectField name="dependsOnId" label="Depends on" options={((planning?.[dependencyType === "task" ? "tasks" : "milestones"] as Row[]) ?? []).map((row) => ({
              value: String(row.id), label: String(row.title),
            }))} required/>
            <div className="md:col-span-2"><Submit>Add dependency</Submit></div>
          </form></Panel>
        </div>}
        {projectId && planning && <div className="grid gap-5 xl:grid-cols-2">
          <Panel title={`Milestones · ${String((planning.project as Row | undefined)?.code ?? "")}`}><Table rows={(planning.milestones as Row[]) ?? []} columns={[
            ["code","Code"],["title","Title"],["status","Status"],["due_date","Due date"],["assignee_name","Assignee"],
          ]} actions={canEdit ? (row) => row.status !== "completed" ? <button onClick={() => void mutate(`/api/operations/projects/${projectId}/planning`, {
            action: "milestoneStatus", milestoneId: row.id, status: row.status === "planned" ? "in_progress" : "completed",
          }, "Milestone status updated.")} className="text-teal-700 underline">{row.status === "planned" ? "Start" : "Complete"}</button> : "—" : undefined}/></Panel>
          <Panel title="Project tasks and dependencies"><Table rows={(planning.tasks as Row[]) ?? []} columns={[
            ["title","Task"],["discipline","Team"],["status","Status"],["assignee_name","Assignee"],["due_date","Due"],
          ]} actions={canEdit ? (row) => {
            const updateStatus = (status: string) => void mutate(`/api/operations/projects/${projectId}/planning`, {
              action: "taskStatus", taskId: row.id, status,
            }, "Task status updated.");
            if (row.status === "todo") return <span className="flex gap-2">
              <button onClick={() => updateStatus("in_progress")} className="text-teal-700 underline">Start</button>
              <button onClick={() => updateStatus("blocked")} className="text-amber-700 underline">Block</button>
            </span>;
            if (row.status === "blocked") return <button onClick={() => updateStatus("in_progress")} className="text-teal-700 underline">Resume</button>;
            if (row.status === "in_progress") return <button onClick={() => updateStatus("done")} className="text-teal-700 underline">Complete</button>;
            return "—";
          } : undefined}/><p className="mt-3 text-xs text-slate-500">Task records are shared with the existing operations module. Dependency creation and cycle validation are handled by the planning API.</p></Panel>
          <Panel title="Assigned resources"><Table rows={(planning.resources as Row[]) ?? []} columns={[
            ["user_name","Person"],["discipline","Discipline"],["allocation_percent","Allocation %"],["starts_on","Start"],["ends_on","End"],
          ]}/></Panel>
          <Panel title="Project costs"><Table rows={(planning.costs as Row[]) ?? []} columns={[
            ["cost_type","Type"],["description","Description"],["source","Source"],["quantity","Quantity"],
            ["estimated_total","Estimated total"],["actual_total","Actual total"],
          ]}/></Panel>
          <Panel title="Milestone dependencies"><Table rows={(planning.milestoneDependencies as Row[]) ?? []} columns={[
            ["milestoneTitle","Milestone"],["dependsOnTitle","Depends on"],
          ]}/><Table rows={(planning.taskDependencies as Row[]) ?? []} columns={[
            ["taskTitle","Task"],["dependsOnTitle","Depends on"],
          ]}/></Panel>
          <Panel title="Material readiness"><Table rows={(planning.materialReadiness as Row[]) ?? []} columns={[
            ["sku","SKU"],["demandStatus","Demand basis"],["bomRevisionCode","BOM revision"],
            ["requiredQty","Required"],["consumedQty","Used"],["projectReserved","Reserved"],["incomingQty","Incoming"],["shortageQty","Shortage"],
          ]}/></Panel>
          <Panel title="Engineering documents and equipment"><Table rows={(planning.engineeringDocuments as Row[]) ?? []} columns={[
            ["title","Document / program"],["kind","Type"],["revisions","Revisions"],["approved_revision","Approved revision"],
          ]}/></Panel>
          <Panel title="Purchasing and receiving"><Table rows={(planning.purchaseOrders as Row[]) ?? []} columns={[
            ["poNumber","PO"],["supplierName","Supplier"],["status","Status"],["orderedQty","Ordered"],["receivedQty","Received"],["expectedDelivery","Expected"],
          ]}/></Panel>
          <Panel title="Production jobs"><Table rows={(planning.productionJobs as Row[]) ?? []} columns={[
            ["job_code","Job"],["title","Work"],["status","Status"],["planned_qty","Planned"],["completed_qty","Completed"],["scrap_qty","Scrap"],
          ]}/></Panel>
          <Panel title="Field-service work orders"><Table rows={(planning.serviceJobs as Row[]) ?? []} columns={[
            ["asset_tag","Equipment"],["title","Work order"],["status","Status"],["technician_name","Technician"],["scheduled_date","Scheduled"],
          ]}/></Panel>
        </div>}
      </div>}

      {tab === "production" && <div className="space-y-5">
        {canEdit && <div className="grid gap-5 xl:grid-cols-2">
          <Panel title="Create work center"><form onSubmit={(event) => void sendForm(event, "/api/operations/production/work-centers", "Work center created.")} className="grid gap-3 md:grid-cols-2">
            <TextField name="code" label="Center code" required/><TextField name="name" label="Name" required/>
            <TextField name="location" label="Location"/><div className="self-end"><Submit>Create center</Submit></div>
          </form></Panel>
          <Panel title="Create shift"><form onSubmit={(event) => void sendForm(event, "/api/operations/production/shifts", "Shift created.")} className="grid gap-3 md:grid-cols-2">
            <TextField name="code" label="Shift code" required/><TextField name="name" label="Name" required/>
            <TextField name="startsAt" label="Starts" type="time" required/><TextField name="endsAt" label="Ends" type="time" required/>
            <div className="md:col-span-2"><Submit>Create shift</Submit></div>
          </form></Panel>
          <Panel title="Assign job to operator"><form onSubmit={(event) => void sendForm(event, "/api/operations/production/assignments", "Production assignment created.")} className="grid gap-3 md:grid-cols-2">
            <SelectField name="productionJobId" label="Job" options={jobOptions} required/>
            <SelectField name="operatorId" label="Operator" options={userOptions} required/>
            <SelectField name="workCenterId" label="Work center" options={production.workCenters.map((row) => ({ value: String(row.id), label: `${value(row, "code")} · ${value(row, "name")}` }))} required/>
            <SelectField name="shiftId" label="Shift" options={production.shifts.map((row) => ({ value: String(row.id), label: `${value(row, "code")} · ${value(row, "name")}` }))} required/>
            <div className="md:col-span-2"><Submit>Assign job</Submit></div>
          </form></Panel>
          <Panel title="Record downtime"><form onSubmit={(event) => void sendForm(event, "/api/operations/production/downtime", "Downtime recorded.", (form) => ({
            productionJobId: form.get("productionJobId"), workCenterId: form.get("workCenterId"), reason: form.get("reason"),
            startedAt: new Date(String(form.get("startedAt"))).toISOString(), endedAt: new Date(String(form.get("endedAt"))).toISOString(),
            notes: form.get("notes"), idempotencyKey: crypto.randomUUID(),
          }))} className="grid gap-3 md:grid-cols-2">
            <SelectField name="productionJobId" label="Job" options={jobOptions} required/>
            <SelectField name="workCenterId" label="Work center" options={production.workCenters.map((row) => ({ value: String(row.id), label: String(row.code) }))} required/>
            <TextField name="reason" label="Reason" required/><TextField name="startedAt" label="Started at" type="datetime-local" required/>
            <TextField name="endedAt" label="Ended at" type="datetime-local" required/><TextField name="notes" label="Notes"/>
            <div className="md:col-span-2"><button className="rounded-md bg-teal-700 px-4 py-2 text-xs font-semibold text-white">Record downtime</button></div>
          </form></Panel>
        </div>}
        <Panel title="Current production assignments"><Table rows={production.assignments} columns={[
          ["jobCode","Job"],["jobTitle","Work"],["workCenterCode","Work center"],["shiftCode","Shift"],["operatorName","Operator"],["assignedAt","Assigned"],
        ]}/></Panel>
        <Panel title="Downtime history"><Table rows={production.downtime} columns={[
          ["jobCode","Job"],["workCenterCode","Center"],["reason","Reason"],["startedAt","Start"],["endedAt","End"],["durationSeconds","Seconds"],["operatorName","Operator"],
        ]}/></Panel>
        <Panel title="Production jobs"><Table rows={jobs} columns={[
          ["job_code","Job"],["project_code","Project"],["title","Description"],["planned_qty","Planned"],["completed_qty","Completed"],["scrap_qty","Scrap"],["status","Status"],
        ]}/><Link href="/operations" className="mt-3 inline-block text-xs text-teal-700 underline">Record output, scrap, downtime events, and material consumption in the existing production tracker</Link></Panel>
      </div>}

      {tab === "service" && <div className="space-y-5">
        {canEdit && <Panel title="Create and assign field-service work order"><form onSubmit={(event) => void sendForm(event, "/api/operations/service", "Field-service work order created.")} className="grid gap-3 md:grid-cols-2">
          <SelectField name="project_id" label="Project" options={projectOptions}/>
          <SelectField name="asset_id" label="Equipment" required options={assets.map((asset) => ({
            value: String(asset.id), label: `${value(asset, "asset_tag")} · ${value(asset, "name")}`,
          }))}/>
          <TextField name="title" label="Work order" required/>
          <SelectField name="assigned_to" label="Assigned technician" options={userOptions}/>
          <TextField name="scheduled_date" label="Scheduled date" type="date"/>
          <TextField name="notes" label="Work instructions"/>
          <div className="md:col-span-2"><Submit>Create work order</Submit></div>
        </form></Panel>}
        <Panel title="Select field-service work order"><select value={serviceId} onChange={(event) => { setService(null); setServiceId(event.target.value); }} className="h-10 w-full rounded-md border bg-white px-2 text-sm">
          <option value="">Select a service job…</option>{serviceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></Panel>
        {serviceId && service && <div className="grid gap-5 xl:grid-cols-2">
          <Panel title="Work order and updates"><div className="mb-3 text-sm font-semibold">{value(service.job as Row, "title")} · {value(service.job as Row, "status")}</div>
            <p className="mb-3 text-xs text-slate-500">{value(service.job as Row, "asset_tag")} · {value(service.job as Row, "asset_name")} · {value(service.job as Row, "customer_site")} · Assigned to {value(service.job as Row, "technician_name")}</p>
            <form onSubmit={(event) => void sendForm(event, `/api/operations/service/${serviceId}/updates`, "Service update recorded.", (form) => ({
              updateType: form.get("updateType"), ...(form.get("status") ? { status: form.get("status") } : {}), notes: form.get("notes"),
            }))} className="grid gap-3 md:grid-cols-2">
              <SelectField name="updateType" label="Update type" required options={[
                { value: "note", label: "Note" }, { value: "outcome", label: "Outcome" }, { value: "status", label: "Status" },
              ]}/>
              <SelectField name="status" label="New status" options={[
                { value: "scheduled", label: "Scheduled" }, { value: "in_progress", label: "In progress" }, { value: "completed", label: "Completed" },
              ]}/>
              <TextField name="notes" label="Work notes" required/><div className="self-end"><Submit>Add update</Submit></div>
            </form>
            <div className="mt-4"><Table rows={(service.updates as Row[]) ?? []} columns={[
              ["updateType","Type"],["status","Status"],["notes","Notes"],["actorName","Technician"],["createdAt","Recorded"],
            ]}/></div>
          </Panel>
          <Panel title="Parts used and returned"><form onSubmit={(event) => void sendForm(event, `/api/operations/service/${serviceId}/parts`, "Part transaction posted to inventory.", (form) => ({
            action: form.get("action"), sku: form.get("sku"), quantity: form.get("quantity"), location: form.get("location"), bin: form.get("bin"),
            notes: form.get("notes"), idempotencyKey: crypto.randomUUID(),
          }))} className="grid gap-3 md:grid-cols-2">
            <SelectField name="action" label="Action" required options={[{ value: "used", label: "Used" }, { value: "returned", label: "Returned" }]}/>
            <SelectField name="sku" label="Inventory item" options={itemOptions} required/>
            <TextField name="quantity" label="Quantity" type="number" min="0.001" step="0.001" required/>
            <TextField name="location" label="Location" required/><TextField name="bin" label="Bin" required/><TextField name="notes" label="Notes"/>
            <div className="md:col-span-2"><Submit>Record part transaction</Submit></div>
          </form>
          <div className="mt-4"><Table rows={(service.parts as Row[]) ?? []} columns={[
            ["action","Action"],["sku","SKU"],["itemName","Item"],["quantity","Qty"],["location","Location"],["bin","Bin"],["actorName","Technician"],
          ]}/></div></Panel>
          <Panel title="Approved PLC/HMI programs for this equipment"><Table rows={(service.approvedPrograms as Row[]) ?? []} columns={[
            ["kind","Type"],["title","Program"],["revision","Revision"],["fileName","File"],["sha256","SHA-256"],
          ]} actions={(row) => <a className="text-teal-700 underline" href={`/api/engineering/revisions/${row.revision_id}`}>Download</a>}/></Panel>
          <Panel title="Record controller installation"><form onSubmit={(event) => void sendForm(event, `/api/operations/service/${serviceId}/installs`, "Installation record saved.", (form) => ({
            revisionId: form.get("revisionId"), result: form.get("result"), notes: form.get("notes"), idempotencyKey: crypto.randomUUID(),
          }))} className="grid gap-3 md:grid-cols-2">
            <SelectField name="revisionId" label="Approved release" required options={((service.approvedPrograms as Row[]) ?? []).map((row) => ({
              value: String(row.revision_id), label: `${formatDisplayLabel(value(row, "kind"))} · ${value(row, "title")} · rev ${value(row, "revision")}`,
            }))}/>
            <SelectField name="result" label="Installation outcome" required options={[
              { value: "installed", label: "Installed" }, { value: "failed", label: "Failed" }, { value: "rolled_back", label: "Rolled back" },
            ]}/>
            <TextField name="notes" label="Installation notes"/><div className="self-end"><Submit>Record installation</Submit></div>
          </form></Panel>
          <Panel title="Installation history"><Table rows={(service.installs as Row[]) ?? []} columns={[
            ["document_title","Program"],["revision","Revision"],["result","Outcome"],["notes","Notes"],["technician","Technician"],["performed_at","Recorded"],
          ]}/></Panel>
        </div>}
      </div>}
    </div>
  </main>;
}
