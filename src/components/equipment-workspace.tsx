"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { formatDisplayLabel } from "@/lib/display-label";

type Row = Record<string, unknown>;
type User = { id: string; displayName: string; role: "admin" | "operator" | "viewer" };
type Equipment = Row & { id: string; assetTag: string; name: string; status: string };
type EquipmentDetail = { relationships: Row[]; audit: Row[] };
type TelemetryTag = Row & {
  id: string; tagName: string; label: string; dataType: string; semanticType: string; unit: string;
  value?: string | null; numericValue?: string | null; quality?: string | null; observedAt?: string | null;
  freshness?: string; orderingState?: string | null;
};
type TelemetryStatus = {
  assetId: string; connection: string; lastSeenAt: string | null; tags: TelemetryTag[];
  events: Row[]; staleAfterSeconds: number; disconnectedAfterSeconds: number; lastError: string;
  provider: "gateway" | "simulated"; availableSources: Array<"gateway" | "simulated">;
};
type WorkOrder = Row & {
  id: string; assetId: string; title: string; status: string; workType: string;
  dueAt: string | null; assignedTo: string | null; pendingChecklistCount: number;
};
type Options = { equipment: Row[]; users: Row[]; items: Row[]; projects: Row[] };
type Point = { timestamp: string; value: string; numericValue?: string | null; quality: string; orderingState?: string };
type History = { assetId: string; provider: string; tag: { id: string; label: string; unit: string }; points: Point[] };
type Metrics = { mtbfSeconds: number | null; mttrSeconds: number | null; availabilityPercent: number; downtimeSeconds: number; failureCount: number };
type Analytics = { days: number; from: string; to: string; equipment: Array<{ assetId: string; assetTag: string; name: string; metrics: Metrics; failureHistory: Row[] }> };
type AlarmData = { assetId: string; rules: Row[]; alarms: Row[] };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store", signal: init?.signal ?? AbortSignal.timeout(10_000) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "The request could not be completed.");
  return result;
}

function formValues(form: HTMLFormElement): Record<string, FormDataEntryValue> {
  return Object.fromEntries(new FormData(form).entries());
}

function format(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value)) return new Date(value).toLocaleString();
  return String(value);
}

function seconds(value: number | null): string {
  if (value === null) return "N/A";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function Panel({ children, title, className = "" }: { children: ReactNode; title: string; className?: string }) {
  return <section className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
    <h2 className="mb-4 text-base font-bold text-slate-800">{title}</h2>{children}
  </section>;
}

function Field({ label, name, type = "text", required = false, defaultValue, min, step }: {
  label: string; name: string; type?: string; required?: boolean; defaultValue?: string; min?: string; step?: string;
}) {
  return <label className="block text-xs font-semibold text-slate-700">
    <span className="mb-1 block">{label}{required ? " *" : ""}</span>
    <input name={name} type={type} required={required} defaultValue={defaultValue} min={min} step={step}
      className="h-10 w-full rounded-md border border-slate-300 px-2 text-sm"/>
  </label>;
}

function Button({ children, onClick, type = "button", disabled = false, tone = "primary" }: {
  children: ReactNode; onClick?: () => void; type?: "button" | "submit"; disabled?: boolean; tone?: "primary" | "secondary";
}) {
  return <button type={type} onClick={onClick} disabled={disabled}
    className={`rounded-md px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
      tone === "primary" ? "bg-teal-700 text-white hover:bg-teal-800" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
    }`}>{children}</button>;
}

function Select({ label, name, options, required = false, defaultValue = "" }: {
  label: string; name: string; options: Array<{ value: string; label: string }>; required?: boolean; defaultValue?: string;
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

export default function EquipmentWorkspace() {
  const [user, setUser] = useState<User | null>(null);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [plans, setPlans] = useState<Row[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [options, setOptions] = useState<Options>({ equipment: [], users: [], items: [], projects: [] });
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryStatus | null>(null);
  const [alarmData, setAlarmData] = useState<AlarmData | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [equipmentDetail, setEquipmentDetail] = useState<EquipmentDetail | null>(null);
  const [detailAssetId, setDetailAssetId] = useState("");
  const [downtime, setDowntime] = useState<Row[]>([]);
  const [downtimeAssetId, setDowntimeAssetId] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [selectedTagId, setSelectedTagId] = useState("");
  const [selectedWorkOrderId, setSelectedWorkOrderId] = useState("");
  const [workOrderDetail, setWorkOrderDetail] = useState<Row | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [simulationMode, setSimulationMode] = useState("normal");
  const [sourceChoice, setSourceChoice] = useState("");
  const [gateways, setGateways] = useState<Row[]>([]);
  const [clock, setClock] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const canManage = user?.role === "admin" || user?.role === "operator";
  const selectedAsset = equipment.find((item) => item.id === selectedAssetId) ?? null;
  const selectedWorkOrder = workOrders.find((item) => item.id === selectedWorkOrderId) ?? null;
  const selectedTelemetry = telemetry?.assetId === selectedAssetId && (!sourceChoice || telemetry.provider === sourceChoice) ? telemetry : null;
  const selectedAlarms = alarmData?.assetId === selectedAssetId ? alarmData : null;
  const selectedDowntime = downtimeAssetId === selectedAssetId ? downtime : [];
  const selectedEquipmentDetail = detailAssetId === selectedAssetId ? equipmentDetail : null;

  const refresh = useCallback(async () => {
    if (!user) return;
    const [equipmentData, workOrderData, analyticsData] = await Promise.all([
      api<{ equipment: Equipment[] }>("/api/operations/equipment"),
      api<{ workOrders: WorkOrder[] }>("/api/operations/maintenance/work-orders"),
      api<Analytics>(`/api/operations/analytics/reliability?days=${windowDays}`),
    ]);
    setEquipment(equipmentData.equipment);
    setWorkOrders(workOrderData.workOrders);
    setAnalytics(analyticsData);
    if (user.role === "admin") {
      setGateways((await api<{ gateways: Row[] }>("/api/gateways")).gateways);
    }
    if (canManage) {
      const [planData, optionData] = await Promise.all([
        api<{ plans: Row[] }>("/api/operations/maintenance/plans"),
        api<Options>("/api/operations/maintenance/options"),
      ]);
      setPlans(planData.plans);
      setOptions(optionData);
    }
    if (!selectedAssetId && equipmentData.equipment[0]) setSelectedAssetId(equipmentData.equipment[0].id);
  }, [canManage, selectedAssetId, user, windowDays]);

  useEffect(() => {
    let active = true;
    void api<{ user: User | null }>("/api/auth/status").then(async (result) => {
      if (!active) return;
      setUser(result.user);
      if (result.user) await refresh();
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Unable to load equipment operations.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [refresh]);

  const loadTelemetry = useCallback(async () => {
    if (!selectedAssetId) return;
    const [status, downtimeData, alarms] = await Promise.all([
      api<TelemetryStatus>(`/api/operations/equipment/${selectedAssetId}/telemetry${sourceChoice ? `?provider=${sourceChoice}` : ""}`),
      api<{ downtime: Row[] }>(`/api/operations/equipment/${selectedAssetId}/downtime`),
      api<{ rules: Row[]; alarms: Row[] }>(`/api/operations/equipment/${selectedAssetId}/alarms`),
    ]);
    setTelemetry(status);
    setAlarmData({ assetId: selectedAssetId, ...alarms });
    setDowntime(downtimeData.downtime);
    setDowntimeAssetId(selectedAssetId);
    setSelectedTagId((current) => current && status.tags.some((tag) => tag.id === current)
      ? current
      : String(status.tags.find((tag) => tag.semanticType === "metric" && tag.dataType === "number")?.id ?? ""));
  }, [selectedAssetId, sourceChoice]);

  useEffect(() => {
    let active = true;
    if (!selectedAssetId) return;
    void Promise.all([
      api<TelemetryStatus>(`/api/operations/equipment/${selectedAssetId}/telemetry${sourceChoice ? `?provider=${sourceChoice}` : ""}`),
      api<{ downtime: Row[] }>(`/api/operations/equipment/${selectedAssetId}/downtime`),
      api<{ rules: Row[]; alarms: Row[] }>(`/api/operations/equipment/${selectedAssetId}/alarms`),
    ]).then(([status, downtimeData, alarms]) => {
      if (!active) return;
      setTelemetry(status);
      setAlarmData({ assetId: selectedAssetId, ...alarms });
      setDowntime(downtimeData.downtime);
      setDowntimeAssetId(selectedAssetId);
      setSelectedTagId((current) => current && status.tags.some((tag) => tag.id === current)
        ? current
        : String(status.tags.find((tag) => tag.semanticType === "metric" && tag.dataType === "number")?.id ?? ""));
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Unable to load equipment telemetry.");
    });
    return () => { active = false; };
  }, [selectedAssetId, sourceChoice]);

  useEffect(() => {
    if (!selectedAssetId) return;
    const timer = setInterval(() => {
      void loadTelemetry().catch((reason: unknown) => {
        setTelemetry(null);
        setError(reason instanceof Error ? reason.message : "Unable to refresh telemetry.");
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [loadTelemetry, selectedAssetId]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    if (selectedAssetId && selectedTagId) {
      const provider = selectedTelemetry?.provider;
      if (!provider) return;
      const load = () => {
        void api<Omit<History, "assetId" | "provider">>(`/api/operations/equipment/${selectedAssetId}/telemetry/history?tagId=${encodeURIComponent(selectedTagId)}&days=1&provider=${provider}`)
          .then((result) => { if (active) setHistory({ ...result, assetId: selectedAssetId, provider }); })
          .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load telemetry trend."); });
      };
      load();
      const timer = setInterval(load, 15_000);
      return () => { active = false; clearInterval(timer); };
    }
    return () => { active = false; };
  }, [selectedAssetId, selectedTagId, selectedTelemetry?.provider]);

  useEffect(() => {
    let active = true;
    if (selectedWorkOrderId) {
      void api<Row>(`/api/operations/maintenance/work-orders/${selectedWorkOrderId}`)
        .then((result) => { if (active) setWorkOrderDetail(result); })
        .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load work order."); });
    }
    return () => { active = false; };
  }, [selectedWorkOrderId]);

  useEffect(() => {
    let active = true;
    if (selectedAssetId) {
      void api<EquipmentDetail>(`/api/operations/equipment/${selectedAssetId}`)
        .then((result) => {
          if (!active) return;
          setEquipmentDetail(result);
          setDetailAssetId(selectedAssetId);
        })
        .catch((reason: unknown) => {
          if (active) setError(reason instanceof Error ? reason.message : "Unable to load equipment history.");
        });
    }
    return () => { active = false; };
  }, [selectedAssetId]);

  const run = async (action: () => Promise<unknown>, success: string, refreshData = true) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (refreshData) await refresh();
      if (selectedAssetId) await loadTelemetry();
      if (selectedAssetId) {
        setEquipmentDetail(await api<EquipmentDetail>(`/api/operations/equipment/${selectedAssetId}`));
        setDetailAssetId(selectedAssetId);
      }
      if (selectedWorkOrderId) {
        setWorkOrderDetail(await api<Row>(`/api/operations/maintenance/work-orders/${selectedWorkOrderId}`));
      }
      setNotice(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The operation could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (action: (values: Record<string, FormDataEntryValue>) => Promise<unknown>, success: string) =>
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const values = formValues(event.currentTarget);
      void run(() => action(values), success);
    };

  const reload = () => void run(async () => {
    await refresh();
    if (selectedWorkOrderId) setWorkOrderDetail(await api<Row>(`/api/operations/maintenance/work-orders/${selectedWorkOrderId}`));
  }, "Equipment workspace refreshed.");

  const metricOptions = selectedTelemetry?.tags
    .filter((tag) => tag.dataType === "number" && tag.semanticType === "metric")
    .map((tag) => ({ value: tag.id, label: `${tag.label}${tag.unit ? ` (${tag.unit})` : ""}` })) ?? [];
  const selectedHistory = history?.assetId === selectedAssetId && history.tag.id === selectedTagId &&
    history.provider === selectedTelemetry?.provider ? history : null;
  const chartPoints = (selectedHistory?.points ?? [])
    .filter((point) => point.numericValue !== null && point.numericValue !== undefined)
    .map((point) => ({ x: new Date(point.timestamp).getTime(), y: Number(point.numericValue) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const chartCoordinates = useMemo(() => {
    if (chartPoints.length < 2) return "";
    const minimum = Math.min(...chartPoints.map((point) => point.y));
    const maximum = Math.max(...chartPoints.map((point) => point.y));
    const span = maximum - minimum || 1;
    return chartPoints.map((point, index) => {
      const x = 10 + index * 280 / (chartPoints.length - 1);
      const y = 110 - ((point.y - minimum) / span) * 90;
      return `${x},${y}`;
    }).join(" ");
  }, [chartPoints]);
  const statusTag = selectedTelemetry?.tags.find((tag) => tag.semanticType === "state");
  const freshnessOf = (tag: TelemetryTag | undefined) => {
    if (!tag?.observedAt || !Number.isFinite(Date.parse(tag.observedAt))) return "missing";
    return clock - Date.parse(tag.observedAt) <= (selectedTelemetry?.staleAfterSeconds ?? 0) * 1000 ? "fresh" : "stale";
  };
  const sourceConnected = selectedTelemetry?.connection === "connected" && !!selectedTelemetry.lastSeenAt &&
    clock - Date.parse(selectedTelemetry.lastSeenAt) <= selectedTelemetry.disconnectedAfterSeconds * 1000;
  const freshness = freshnessOf(statusTag);
  const stateLive = sourceConnected && freshness === "fresh" &&
    statusTag?.quality === "good" && statusTag.orderingState === "ordered";
  const machineState = stateLive ? statusTag?.value ?? "unknown" : "Unavailable";
  const ordersForAsset = workOrders.filter((order) => order.assetId === selectedAssetId);
  const detail = workOrderDetail as { workOrder?: Row; checklist?: Row[]; parts?: Row[]; costs?: Row[]; events?: Row[] } | null;
  const selectedOrderStatus = String(detail?.workOrder?.status ?? selectedWorkOrder?.status ?? "");
  const selectedOrderAssignee = String(detail?.workOrder?.assigned_to ?? selectedWorkOrder?.assignedTo ?? "");
  const selectedChecklist = detail?.checklist ?? [];
  const selectedParts = detail?.parts ?? [];
  const selectedCosts = detail?.costs ?? [];
  const selectedEvents = detail?.events ?? [];

  if (loading) return <main className="grid min-h-screen place-items-center bg-slate-100 text-slate-600">Connecting to equipment operations…</main>;
  if (!user) return <main className="grid min-h-screen place-items-center bg-slate-100 p-5">
    <section className="max-w-md rounded-xl border bg-white p-8 text-center shadow-sm">
      <h1 className="text-xl font-bold">Sign in required</h1>
      <p className="my-4 text-sm text-slate-600">Sign in to view equipment, maintenance, and telemetry records.</p>
      <Link href="/" className="text-teal-700 underline">Go to sign in</Link>
    </section>
  </main>;

  return <main className="min-h-screen bg-slate-100 text-slate-800">
    <header className="bg-[#16272b] px-5 py-5 text-white lg:px-10">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-teal-200">CloudForge · Equipment operations</p>
          <h1 className="mt-1 text-2xl font-bold">Equipment, maintenance & monitoring</h1>
          <p className="mt-1 text-xs text-slate-300">Read-only equipment monitoring · simulator and customer gateway sources</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/operations" className="rounded-md border border-slate-500 px-3 py-2 text-xs font-semibold hover:bg-slate-700">Integrated operations</Link>
          <Link href="/operations/phase3" className="rounded-md border border-slate-500 px-3 py-2 text-xs font-semibold hover:bg-slate-700">Phase 3 workflows</Link>
          <Button tone="secondary" disabled={busy} onClick={reload}>Refresh</Button>
        </div>
      </div>
    </header>

    <div className="mx-auto max-w-[1600px] space-y-5 p-4 lg:p-8">
      {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
      {notice && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</div>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
        <Panel title="Equipment register" className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <label className="min-w-[220px] flex-1 text-xs font-semibold">
              Selected equipment
              <select value={selectedAssetId} onChange={(event) => { setSourceChoice(""); setSelectedAssetId(event.target.value); }}
                className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm">
                {!equipment.length && <option value="">No equipment available</option>}
                {equipment.map((asset) => <option key={asset.id} value={asset.id}>{asset.assetTag} · {asset.name}</option>)}
              </select>
            </label>
            {canManage && selectedAsset && <Button tone="secondary" disabled={busy || selectedAsset.status === "retired"}
              onClick={() => void run(() => api(`/api/operations/equipment/${selectedAsset.id}`, { method: "DELETE" }), "Equipment retired; its history was preserved.")}>
              Retire equipment
            </Button>}
          </div>

          {selectedAsset && <div className="grid gap-3 rounded-lg bg-slate-50 p-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div><span className="text-slate-500">Asset tag</span><strong className="mt-1 block">{selectedAsset.assetTag}</strong></div>
            <div><span className="text-slate-500">Customer site</span><strong className="mt-1 block">{format(selectedAsset.customerSite)}</strong></div>
            <div><span className="text-slate-500">Registry status</span><strong className="mt-1 block capitalize">{format(selectedAsset.status)}</strong></div>
            <div><span className="text-slate-500">Linked project</span><strong className="mt-1 block">{format(selectedAsset.projectCode)}</strong></div>
            <div><span className="text-slate-500">Manufacturer / model</span><strong className="mt-1 block">{format(selectedAsset.manufacturer)} {format(selectedAsset.model)}</strong></div>
            <div><span className="text-slate-500">Serial number</span><strong className="mt-1 block">{format(selectedAsset.serialNumber)}</strong></div>
            <div><span className="text-slate-500">Location</span><strong className="mt-1 block">{format(selectedAsset.location || selectedAsset.area)}</strong></div>
            <div><span className="text-slate-500">PLC / HMI</span><strong className="mt-1 block">{format(selectedAsset.plcModel)} / {format(selectedAsset.hmiModel)}</strong></div>
          </div>}

          {canManage && <details className="mt-4 rounded-lg border border-slate-200 p-4">
            <summary className="cursor-pointer text-xs font-bold text-teal-800">Register new equipment</summary>
            <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={submit(async (values) => {
              const result = await api<{ id: string }>("/api/operations/equipment", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  assetTag: values.assetTag, name: values.name, customerSite: values.customerSite,
                  location: values.location, manufacturer: values.manufacturer, model: values.model,
                  serialNumber: values.serialNumber, plcMake: values.plcMake, plcModel: values.plcModel,
                  hmiMake: values.hmiMake, hmiModel: values.hmiModel, area: values.area, notes: values.notes,
                  installedOn: values.installedOn || null, projectId: values.projectId || null, parentAssetId: values.parentAssetId || null,
                }),
              });
              setSelectedAssetId(result.id);
            }, "Equipment registered with simulated telemetry tags.")}>
              <Field label="Asset tag" name="assetTag" required/>
              <Field label="Equipment name" name="name" required/>
              <Field label="Customer site" name="customerSite" required/>
              <Field label="Location / line" name="location"/>
              <Select label="Project link" name="projectId" options={options.projects.map((project) => ({
                value: String(project.id), label: `${String(project.code)} · ${String(project.name)}`,
              }))}/>
              <Select label="Parent equipment" name="parentAssetId" options={options.equipment.map((asset) => ({
                value: String(asset.id), label: `${String(asset.assetTag)} · ${String(asset.name)}`,
              }))}/>
              <Field label="Manufacturer" name="manufacturer"/>
              <Field label="Model" name="model"/>
              <Field label="Serial number" name="serialNumber"/>
              <Field label="Installed on" name="installedOn" type="date"/>
              <Field label="PLC make" name="plcMake"/>
              <Field label="PLC model" name="plcModel"/>
              <Field label="HMI make" name="hmiMake"/>
              <Field label="HMI model" name="hmiModel"/>
              <label className="text-xs font-semibold md:col-span-2">Notes<textarea name="notes" rows={2} className="mt-1 w-full rounded-md border px-2 py-2 text-sm"/></label>
              <div><Button type="submit" disabled={busy}>Create equipment</Button></div>
            </form>
          </details>}

          {canManage && selectedAsset && <details className="mt-3 rounded-lg border border-slate-200 p-4">
            <summary className="cursor-pointer text-xs font-bold text-slate-700">Edit equipment details</summary>
            <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={submit(async (values) => {
              await api(`/api/operations/equipment/${selectedAsset.id}`, {
                method: "PATCH", headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  assetTag: values.assetTag, name: values.name, customerSite: values.customerSite,
                  location: values.location, manufacturer: values.manufacturer, model: values.model,
                  serialNumber: values.serialNumber, status: values.status, installedOn: values.installedOn || null,
                  projectId: values.projectId || null, parentAssetId: values.parentAssetId || null, plcMake: values.plcMake,
                  plcModel: values.plcModel, hmiMake: values.hmiMake, hmiModel: values.hmiModel, notes: values.notes,
                }),
              });
            }, "Equipment details updated.")}>
              <Field label="Asset tag" name="assetTag" required defaultValue={String(selectedAsset.assetTag)}/>
              <Field label="Equipment name" name="name" required defaultValue={String(selectedAsset.name)}/>
              <Field label="Customer site" name="customerSite" required defaultValue={String(selectedAsset.customerSite ?? "")}/>
              <Field label="Location / line" name="location" defaultValue={String(selectedAsset.location ?? "")}/>
              <Select label="Project link" name="projectId" defaultValue={String(selectedAsset.projectId ?? "")} options={options.projects.map((project) => ({
                value: String(project.id), label: `${String(project.code)} · ${String(project.name)}`,
              }))}/>
              <Select label="Parent equipment" name="parentAssetId" defaultValue={String(selectedAsset.parentAssetId ?? "")} options={options.equipment.filter((asset) => asset.id !== selectedAssetId).map((asset) => ({
                value: String(asset.id), label: `${String(asset.assetTag)} · ${String(asset.name)}`,
              }))}/>
              <Field label="Manufacturer" name="manufacturer" defaultValue={String(selectedAsset.manufacturer ?? "")}/>
              <Field label="Model" name="model" defaultValue={String(selectedAsset.model ?? "")}/>
              <Field label="Serial number" name="serialNumber" defaultValue={String(selectedAsset.serialNumber ?? "")}/>
              <Field label="Installed on" name="installedOn" type="date" defaultValue={String(selectedAsset.installedOn ?? "").slice(0, 10)}/>
              <label className="text-xs font-semibold">Registry status<select name="status" defaultValue={String(selectedAsset.status)}
                className="mt-1 h-10 w-full rounded-md border bg-white px-2">
                {["active","standby","maintenance","retired"].map((status) => <option key={status} value={status}>{status}</option>)}
              </select></label>
              <Field label="PLC make" name="plcMake" defaultValue={String(selectedAsset.plcMake ?? "")}/>
              <Field label="PLC model" name="plcModel" defaultValue={String(selectedAsset.plcModel ?? "")}/>
              <Field label="HMI make" name="hmiMake" defaultValue={String(selectedAsset.hmiMake ?? "")}/>
              <Field label="HMI model" name="hmiModel" defaultValue={String(selectedAsset.hmiModel ?? "")}/>
              <label className="text-xs font-semibold md:col-span-2">Notes<textarea name="notes" rows={2} defaultValue={String(selectedAsset.notes ?? "")}
                className="mt-1 w-full rounded-md border px-2 py-2 text-sm"/></label>
              <div><Button type="submit" disabled={busy}>Save equipment</Button></div>
            </form>
          </details>}
          <details className="mt-4 rounded-lg border border-slate-200 p-4" open>
            <summary className="cursor-pointer text-xs font-bold text-slate-700">Cross-department equipment history</summary>
            <ol className="mt-3 space-y-2 text-xs">
              {(selectedEquipmentDetail?.relationships ?? []).map((entry) => <li key={`${String(entry.kind)}-${String(entry.id)}`}
                className="flex flex-wrap justify-between gap-2 border-b pb-2">
                <span><strong>{formatDisplayLabel(String(entry.kind))}</strong> · {String(entry.label)} · {String(entry.detail)}</span>
                <time dateTime={String(entry.occurred_at)} className="text-slate-500">{format(entry.occurred_at)}</time>
              </li>)}
              {!selectedEquipmentDetail?.relationships.length && <li className="text-slate-500">No linked project, engineering, production, or field-service records yet.</li>}
            </ol>
            <h3 className="mb-2 mt-4 text-xs font-bold">Equipment audit trail</h3>
            <ol className="space-y-1 text-[10px]">
              {(selectedEquipmentDetail?.audit ?? []).slice(0, 10).map((entry, index) => <li key={`${String(entry.action)}-${String(entry.occurredAt)}-${index}`}>
                {String(entry.action)} · {String(entry.actor)} · {format(entry.occurredAt)}
              </li>)}
              {!selectedEquipmentDetail?.audit.length && <li className="text-slate-500">No equipment audit events yet.</li>}
            </ol>
          </details>
        </Panel>

        <Panel title="Machine monitoring">
          {!selectedAsset && <p className="text-sm text-slate-500">Register or select equipment to view telemetry.</p>}
          {selectedAsset && <>
            <label className="mb-3 block text-xs font-semibold">Telemetry source
              <select value={selectedTelemetry?.provider ?? ""} onChange={(event) => setSourceChoice(event.target.value)}
                className="ml-2 h-9 rounded-md border bg-white px-2">
                {!selectedTelemetry && <option value="">Loading</option>}
                {(selectedTelemetry?.availableSources ?? []).map((provider) =>
                  <option key={provider} value={provider}>{provider === "gateway" ? "Customer gateway" : "Simulator"}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div className={`rounded-lg p-4 ${sourceConnected ? "bg-emerald-50 text-emerald-900" : "bg-rose-50 text-rose-900"}`}>
                <span className="text-[10px] font-bold uppercase tracking-wider">Connection</span>
                <strong className="mt-1 block text-lg capitalize">{selectedTelemetry ? (sourceConnected ? "connected" : "disconnected") : "unknown"}</strong>
                <span className="text-[11px]">Last source heartbeat: {format(selectedTelemetry?.lastSeenAt)}</span>
                {selectedTelemetry?.lastError && <p className="text-[11px]">{selectedTelemetry.lastError}</p>}
              </div>
              <div className={`rounded-lg p-4 ${stateLive ? "bg-teal-50 text-teal-900" : "bg-amber-50 text-amber-900"}`}>
                <span className="text-[10px] font-bold uppercase tracking-wider">Machine state</span>
                <strong className="mt-1 block text-lg capitalize">{String(machineState)}</strong>
                <span className="text-[11px]">{stateLive ? "Current reading" : "Not live"} · {freshness} · quality {statusTag?.quality ?? "missing"}</span>
              </div>
            </div>
            {canManage && <div className="mt-4 flex flex-wrap items-end gap-2">
              <label className="text-xs font-semibold">Simulated scenario<select value={simulationMode} onChange={(event) => setSimulationMode(event.target.value)}
                className="mt-1 block h-10 rounded-md border bg-white px-2">
                {["normal","stopped","fault","stale","offline","out_of_order","invalid"].map((mode) => <option key={mode} value={mode}>{mode.replace("_"," ")}</option>)}
              </select></label>
              <Button disabled={busy} onClick={() => void run(async () => {
                await api("/api/operations/telemetry/simulate", {
                  method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ assetId: selectedAsset.id, mode: simulationMode }),
                });
              }, `Simulated ${simulationMode.replace("_"," ")} telemetry recorded.`)}>Generate simulated sample</Button>
            </div>}
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {selectedTelemetry?.tags.map((tag) => <div key={tag.id} className="rounded-lg border border-slate-100 p-3 text-xs">
                <div className="flex justify-between gap-2"><strong>{tag.label}</strong><span className={`rounded px-2 py-0.5 ${tag.quality === "good" ? "bg-emerald-50 text-emerald-800" : tag.quality === "bad" ? "bg-rose-50 text-rose-800" : "bg-amber-50 text-amber-800"}`}>
                  {tag.quality === "bad" ? "invalid / bad" : tag.quality ?? "no sample"}
                </span></div>
                <p className="mt-1 text-lg font-bold">{format(tag.value)}{tag.unit ? ` ${tag.unit}` : ""}</p>
                <p className="text-[10px] text-slate-500">{sourceConnected && freshnessOf(tag) === "fresh" && tag.quality === "good" && tag.orderingState === "ordered" ? "Current" : "Cached / not live"} · {freshnessOf(tag)} · {tag.orderingState === "out_of_order" ? "delayed / out of order" : tag.orderingState ?? "no sample"} · observed {format(tag.observedAt)}</p>
              </div>)}
            </div>
            <div className="mt-5">
              <label className="text-xs font-semibold">Trend<select value={selectedTagId} onChange={(event) => setSelectedTagId(event.target.value)}
                className="ml-2 h-9 rounded-md border bg-white px-2">
                {!metricOptions.length && <option value="">No numeric metrics</option>}
                {metricOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select></label>
              {selectedHistory && <>
                <figure className="mt-3 rounded-lg bg-slate-50 p-3">
                  <figcaption className="text-xs font-semibold">{selectedHistory.tag.label} trend · last 24 hours</figcaption>
                  {chartCoordinates ? <svg viewBox="0 0 300 125" role="img" aria-label={`${selectedHistory.tag.label} numeric trend`} className="mt-2 h-36 w-full">
                    <line x1="10" y1="110" x2="290" y2="110" stroke="#94a3b8" strokeWidth="1"/>
                    <polyline points={chartCoordinates} fill="none" stroke="#0f766e" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"/>
                  </svg> : <p className="py-8 text-center text-xs text-slate-500">At least two valid numeric samples are required to draw a trend.</p>}
                  <p className="text-[10px] text-slate-500">{selectedHistory.points.length} samples · bad-quality and non-numeric values are excluded from the chart.</p>
                </figure>
                <div className="mt-2 max-h-40 overflow-auto">
                  <table className="w-full text-left text-[10px]">
                    <caption className="sr-only">Recent telemetry samples</caption>
                    <thead><tr><th className="p-1">Observed</th><th className="p-1">Value</th><th className="p-1">Quality / order</th></tr></thead>
                    <tbody>{selectedHistory.points.slice(-8).reverse().map((point, index) => <tr key={`${point.timestamp}-${index}`} className="border-t">
                      <td className="p-1">{format(point.timestamp)}</td><td className="p-1">{format(point.value)}</td>
                      <td className="p-1">{point.quality} {point.orderingState === "out_of_order" ? "· delayed/out of order" : ""}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              </>}
            </div>
            <div className="mt-5">
              <h3 className="mb-2 text-xs font-bold">Equipment alarms</h3>
              <p className="mb-2 text-xs text-slate-600">CloudForge acknowledgement does not reset a PLC or safety system. Alarms clear only when a fresh, good reading no longer matches.</p>
              <ol className="space-y-2 text-xs">
                {(selectedAlarms?.alarms ?? []).map((entry) => <li key={String(entry.id)} className="rounded border p-2">
                  <strong>{String(entry.name)} · {String(entry.severity)} · {String(entry.provider)} · {entry.clearedAt ? "cleared" : "active"}</strong>
                  <p>Triggered {format(entry.triggeredAt)} · value {format(entry.triggerValue)} · {entry.acknowledgedAt ? `acknowledged by ${format(entry.acknowledgedBy)} at ${format(entry.acknowledgedAt)}` : "not acknowledged"}</p>
                  {canManage && !entry.acknowledgedAt && <Button tone="secondary" disabled={busy} onClick={() => void run(
                    () => api(`/api/operations/equipment/${selectedAsset.id}/alarms/${String(entry.id)}`, { method: "POST" }),
                    "Alarm acknowledged in CloudForge only.",
                  )}>Acknowledge</Button>}
                  <details><summary>History</summary><ol>{(entry.events as Row[]).map((event, index) =>
                    <li key={`${String(event.at)}-${index}`}>{String(event.action)} · {format(event.at)} · {format(event.actor)} {event.value != null ? `· ${format(event.value)}` : ""}</li>
                  )}</ol></details>
                </li>)}
                {!selectedAlarms?.alarms.length && <li className="text-slate-500">No alarms recorded.</li>}
              </ol>
              {canManage && <details className="mt-3 rounded border p-3">
                <summary className="cursor-pointer text-xs font-bold">Add an alarm rule</summary>
                <form className="mt-3 grid gap-2 sm:grid-cols-2" onSubmit={submit(async (values) => {
                  await api(`/api/operations/equipment/${selectedAsset.id}/alarms`, {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ name: values.name, tagId: values.tagId, condition: values.condition,
                      threshold: values.threshold, severity: values.severity, debounceSamples: Number(values.debounceSamples) }),
                  });
                }, "Alarm rule added.")}>
                  <Field label="Rule name" name="name" required/>
                  <Select label="Telemetry tag" name="tagId" required options={(selectedTelemetry?.tags ?? []).map((tag) => ({ value: tag.id, label: tag.label }))}/>
                  <Select label="Condition" name="condition" required options={["above","below","equals"].map((value) => ({ value, label: value }))}/>
                  <Field label="Threshold or state" name="threshold" required/>
                  <Select label="Severity" name="severity" required options={["low","medium","high","critical"].map((value) => ({ value, label: value }))}/>
                  <Field label="Consecutive matching samples (1–10)" name="debounceSamples" type="number" min="1" defaultValue="1" required/>
                  <div><Button type="submit" disabled={busy}>Add rule</Button></div>
                </form>
                <ul className="mt-3 text-xs">{(selectedAlarms?.rules ?? []).map((rule) => <li key={String(rule.id)}>
                  {String(rule.name)} · {String(rule.tagLabel)} {String(rule.condition)} {String(rule.threshold)} · {String(rule.severity)} · {String(rule.debounceSamples)} sample(s) · {rule.enabled ? "enabled" : "paused"}{" "}
                  <button type="button" className="text-teal-800 underline" disabled={busy} onClick={() => void run(
                    () => api(`/api/operations/equipment/${selectedAsset.id}/alarms/rules/${String(rule.id)}`, {
                      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !rule.enabled }),
                    }), rule.enabled ? "Alarm rule paused." : "Alarm rule enabled.",
                  )}>{rule.enabled ? "Pause" : "Enable"}</button>
                  <details className="mb-2 mt-1 rounded border p-2">
                    <summary className="cursor-pointer text-teal-800">Edit rule</summary>
                    <p className="mt-1 text-slate-600">Active alarms must clear before editing. Pending debounce counts reset when settings change.</p>
                    <form key={`${String(rule.condition)}:${String(rule.threshold)}:${String(rule.severity)}:${String(rule.debounceSamples)}`}
                      className="mt-2 grid gap-2 sm:grid-cols-2" onSubmit={submit(async (values) => {
                        await api(`/api/operations/equipment/${selectedAsset.id}/alarms/rules/${String(rule.id)}`, {
                          method: "PUT", headers: { "content-type": "application/json" },
                          body: JSON.stringify({ condition: values.condition, threshold: values.threshold,
                            severity: values.severity, debounceSamples: Number(values.debounceSamples) }),
                        });
                      }, "Alarm rule updated.")}>
                      <Select label="Condition" name="condition" required defaultValue={String(rule.condition)}
                        options={["above","below","equals"].map((value) => ({ value, label: value }))}/>
                      <Field label="Threshold or state" name="threshold" required defaultValue={String(rule.threshold)}/>
                      <Select label="Severity" name="severity" required defaultValue={String(rule.severity)}
                        options={["low","medium","high","critical"].map((value) => ({ value, label: value }))}/>
                      <Field label="Consecutive matching samples (1–10)" name="debounceSamples" type="number" min="1"
                        required defaultValue={String(rule.debounceSamples)}/>
                      <div><Button type="submit" disabled={busy}>Save rule</Button></div>
                    </form>
                  </details>
                </li>)}</ul>
              </details>}
            </div>
            <div className="mt-5">
              <h3 className="mb-2 text-xs font-bold">State and alarm timeline</h3>
              <ol className="max-h-44 space-y-2 overflow-auto text-xs">
                {(selectedTelemetry?.events ?? []).slice(0, 20).map((event) => <li key={String(event.id)} className="border-l-2 border-teal-300 pl-3">
                  <strong className="capitalize">{String(event.tagName)}: {String(event.value || "No alarm")}</strong>
                  <span className="ml-2 text-slate-500">{format(event.observedAt)} · {String(event.quality)}{event.orderingState === "out_of_order" ? " · out of order" : ""}</span>
                </li>)}
                {!selectedTelemetry?.events.length && <li className="text-slate-500">No telemetry events recorded.</li>}
              </ol>
            </div>
          </>}
        </Panel>
      </div>

      {user.role === "admin" && selectedAsset && <Panel title="Customer gateway administration">
        <p className="mb-3 text-xs text-slate-600">Register an Ed25519 public key and explicitly allowed tags. Never paste a private key or password here. One gateway source per equipment is supported.</p>
        <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void run(() => api("/api/gateways", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: data.get("name"), publicKey: data.get("publicKey"),
              expiresAt: data.get("expiresAt") ? new Date(String(data.get("expiresAt"))).toISOString() : "",
              tagIds: data.getAll("tagIds"),
            }),
          }), "Gateway registered. Copy its ID into the gateway configuration.");
        }}>
          <Field label="Gateway name" name="name" required/>
          <Field label="Credential expiry (local time)" name="expiresAt" type="datetime-local" required/>
          <label className="block text-xs font-semibold md:col-span-2">Ed25519 public key (PEM)
            <textarea name="publicKey" required rows={4} className="mt-1 block w-full rounded-md border p-2 font-mono text-xs"/>
          </label>
          <fieldset className="text-xs md:col-span-2"><legend className="font-semibold">Allowed tags for {selectedAsset.assetTag}</legend>
            <div className="mt-2 flex flex-wrap gap-3">{(selectedTelemetry?.tags ?? []).map((tag) =>
              <label key={tag.id}><input type="checkbox" name="tagIds" value={tag.id}/> {tag.label} ({tag.tagName})</label>)}</div>
          </fieldset>
          <div><Button type="submit" disabled={busy}>Register gateway</Button></div>
        </form>
        <ul className="mt-4 space-y-3 text-xs">{gateways.map((gateway) => <li key={String(gateway.id)} className="rounded border p-3">
          <strong>{String(gateway.name)}</strong> · ID {String(gateway.id)} · {gateway.revokedAt ? "revoked" : gateway.enabled ? "enabled" : "disabled"} · expires {format(gateway.expiresAt)} · {String(gateway.tagCount)} tags
          {!gateway.revokedAt && <div className="mt-2 flex flex-wrap gap-2">
            <Button tone="secondary" disabled={busy} onClick={() => void run(
              () => api(`/api/gateways/${String(gateway.id)}`, { method: "PATCH", headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: gateway.enabled ? "disable" : "enable" }) }), "Gateway status updated.",
            )}>{gateway.enabled ? "Disable" : "Enable"}</Button>
            <Button tone="secondary" disabled={busy} onClick={() => {
              if (!window.confirm("Revoke this gateway permanently?")) return;
              void run(() => api(`/api/gateways/${String(gateway.id)}`, { method: "PATCH", headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "revoke" }) }), "Gateway revoked.");
            }}>Revoke</Button>
            <details><summary className="cursor-pointer rounded border px-3 py-2">Rotate public key</summary>
              <form className="mt-2 grid gap-2" onSubmit={submit(async (values) => {
                await api(`/api/gateways/${String(gateway.id)}`, { method: "PATCH", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ action: "rotate", publicKey: values.publicKey,
                    expiresAt: new Date(String(values.expiresAt)).toISOString() }) });
              }, "Gateway credential rotated.")}>
                <Field label="New expiry (local time)" name="expiresAt" type="datetime-local" required/>
                <label>New Ed25519 public key<textarea name="publicKey" required rows={4} className="block w-full rounded border p-2 font-mono"/></label>
                <div><Button type="submit" disabled={busy}>Rotate key</Button></div>
              </form>
            </details>
          </div>}
        </li>)}</ul>
      </Panel>}

      {canManage && <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Preventive maintenance plans">
          <form className="grid gap-3 md:grid-cols-2" onSubmit={submit(async (values) => {
            const checklist = String(values.checklist ?? "").split(/\r?\n/).map((label) => label.trim()).filter(Boolean).map((label) => ({ label, required: true }));
            await api("/api/operations/maintenance/plans", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({
                assetId: values.assetId, name: values.name, description: values.description,
                priority: values.priority, triggerType: values.triggerType,
                intervalDays: values.intervalDays ? Number(values.intervalDays) : undefined,
                nextDueAt: values.nextDueAt ? new Date(String(values.nextDueAt)).toISOString() : undefined,
                intervalValue: values.intervalValue, nextDueValue: values.nextDueValue,
                assignedTo: values.assignedTo || null, checklist,
              }),
            });
          }, "Maintenance plan created.")}>
            <Select label="Equipment" name="assetId" required options={options.equipment.map((item) => ({
              value: String(item.id), label: `${String(item.assetTag)} · ${String(item.name)}`,
            }))}/>
            <Field label="Plan name" name="name" required/>
            <Select label="Trigger" name="triggerType" required options={[
              { value: "calendar", label: "Calendar interval" },
              { value: "runtime", label: "Runtime counter" },
              { value: "cycle", label: "Cycle counter" },
            ]}/>
            <Select label="Priority" name="priority" options={["low","normal","high","critical"].map((value) => ({ value,label:value }))}/>
            <Field label="Calendar interval (days)" name="intervalDays" type="number" min="1"/>
            <Field label="First due date/time" name="nextDueAt" type="datetime-local"/>
            <Field label="Runtime / cycle interval" name="intervalValue" type="number" min="0.001" step="0.001"/>
            <Field label="First counter threshold" name="nextDueValue" type="number" min="0.001" step="0.001"/>
            <Select label="Default assignee" name="assignedTo" options={options.users.map((member) => ({
              value: String(member.id), label: `${String(member.displayName)} · ${String(member.role)}`,
            }))}/>
            <label className="text-xs font-semibold md:col-span-2">Work description<input name="description" className="mt-1 h-10 w-full rounded-md border px-2 text-sm"/></label>
            <label className="text-xs font-semibold md:col-span-2">Checklist (one required step per line)<textarea name="checklist" rows={3}
              className="mt-1 w-full rounded-md border px-2 py-2 text-sm"/></label>
            <div className="flex flex-wrap gap-2 md:col-span-2">
              <Button type="submit" disabled={busy}>Create plan</Button>
              <Button tone="secondary" disabled={busy} onClick={() => void run(async () => {
                const result = await api<{ workOrdersGenerated: number }>("/api/operations/maintenance/scheduler", { method: "POST" });
                setNotice(`${result.workOrdersGenerated} due work order(s) generated.`);
              }, "Maintenance schedule checked.")}>Generate due work orders</Button>
            </div>
          </form>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Preventive maintenance schedule</caption>
              <thead><tr className="border-b text-[10px] uppercase text-slate-500"><th className="p-2">Equipment / plan</th><th className="p-2">Trigger</th><th className="p-2">Next due</th><th className="p-2">State</th><th className="p-2">Actions</th></tr></thead>
              <tbody>{plans.map((plan) => <tr key={String(plan.id)} className="border-b">
                <td className="p-2">{String(plan.assetTag)} · {String(plan.name)}</td>
                <td className="p-2">{String(plan.triggerType)} · {format(plan.intervalDays ?? plan.intervalValue)}</td>
                <td className="p-2">{format(plan.nextDueAt ?? plan.nextDueValue)}</td>
                <td className="p-2">{plan.isActive ? "Active" : "Paused"} · {String(plan.checklistCount)} checklist items</td>
                <td className="p-2"><button disabled={busy} className="text-teal-800 underline" onClick={() => void run(() =>
                  api(`/api/operations/maintenance/plans/${String(plan.id)}`, {
                    method: "PATCH", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ isActive: !plan.isActive }),
                  }), plan.isActive ? "Maintenance plan paused." : "Maintenance plan activated.")}>
                  {plan.isActive ? "Pause" : "Activate"}
                </button></td>
              </tr>)}
              {!plans.length && <tr><td className="p-3 text-slate-500" colSpan={5}>No maintenance plans yet.</td></tr>}</tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Maintenance work orders">
          <form className="grid gap-3 md:grid-cols-2" onSubmit={submit(async (values) => {
            const checklist = String(values.checklist ?? "").split(/\r?\n/).map((label) => label.trim()).filter(Boolean).map((label) => ({ label, required: true }));
            await api("/api/operations/maintenance/work-orders", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({
                assetId: values.assetId, title: values.title, description: values.description,
                workType: values.workType, priority: values.priority, dueAt: values.dueAt ? new Date(String(values.dueAt)).toISOString() : undefined,
                assignedTo: values.assignedTo || null, checklist,
              }),
            });
          }, "Maintenance work order created.")}>
            <Select label="Equipment" name="assetId" required options={options.equipment.map((item) => ({
              value: String(item.id), label: `${String(item.assetTag)} · ${String(item.name)}`,
            }))}/>
            <Field label="Work order title" name="title" required/>
            <Select label="Work type" name="workType" required options={[
              { value: "preventive", label: "Preventive" }, { value: "corrective", label: "Corrective / repair" },
            ]}/>
            <Select label="Priority" name="priority" options={["low","normal","high","critical"].map((value) => ({ value,label:value }))}/>
            <Field label="Due date/time" name="dueAt" type="datetime-local"/>
            <Select label="Assignee" name="assignedTo" options={options.users.map((member) => ({
              value: String(member.id), label: `${String(member.displayName)} · ${String(member.role)}`,
            }))}/>
            <label className="text-xs font-semibold md:col-span-2">Description<input name="description" className="mt-1 h-10 w-full rounded-md border px-2 text-sm"/></label>
            <label className="text-xs font-semibold md:col-span-2">Checklist (one step per line)<textarea name="checklist" rows={2} className="mt-1 w-full rounded-md border px-2 py-2 text-sm"/></label>
            <div className="md:col-span-2"><Button type="submit" disabled={busy}>Create work order</Button></div>
          </form>
          <div className="mt-5">
            <label className="text-xs font-semibold">Open a work order<select value={selectedWorkOrderId} onChange={(event) => setSelectedWorkOrderId(event.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-white px-2">
              {!ordersForAsset.length && <option value="">No work orders for selected equipment</option>}
              {workOrders.map((order) => <option key={order.id} value={order.id}>{String(order.assetTag)} · {order.title} · {order.status}</option>)}
            </select></label>
            <div className="mt-3 max-h-52 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead><tr className="border-b text-[10px] uppercase text-slate-500"><th className="p-2">Work order</th><th className="p-2">Due / assigned</th><th className="p-2">Status</th></tr></thead>
                <tbody>{ordersForAsset.map((order) => <tr key={order.id} className="border-b">
                  <td className="p-2"><button className="font-semibold text-teal-800 underline" onClick={() => setSelectedWorkOrderId(order.id)}>{order.title}</button><span className="ml-1 text-slate-500">({order.workType})</span></td>
                  <td className="p-2">{format(order.dueAt)} · {format(order.assigneeName)}</td><td className="p-2">{order.status}</td>
                </tr>)}
                {!ordersForAsset.length && <tr><td className="p-2 text-slate-500" colSpan={3}>No work orders have been created.</td></tr>}</tbody>
              </table>
            </div>
          </div>
        </Panel>
      </div>}

      {selectedWorkOrderId && detail?.workOrder && String(detail.workOrder.id) === selectedWorkOrderId && <Panel title={`Work order · ${String(detail.workOrder.title)}`}>
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-slate-100 px-2 py-1">{selectedOrderStatus}</span>
          <span>Due {format(detail.workOrder.due_at)}</span>
          <span>Assigned to {format(detail.workOrder.assigneeName)}</span>
          <span>Total net cost ${Number(detail.workOrder.totalCost ?? 0).toFixed(2)}</span>
          <Button tone="secondary" disabled={busy} onClick={() => { setSelectedWorkOrderId(""); setWorkOrderDetail(null); }}>Close details</Button>
          {selectedOrderStatus === "scheduled" && <Button disabled={busy || (user.role === "viewer" && selectedOrderAssignee !== user.id)}
            onClick={() => void run(() => api(`/api/operations/maintenance/work-orders/${selectedWorkOrderId}`, {
              method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start" }),
            }), "Maintenance work order started.")}>Start</Button>}
          {selectedOrderStatus === "in_progress" && <Button disabled={busy || (user.role === "viewer" && selectedOrderAssignee !== user.id)}
            onClick={() => void run(() => api(`/api/operations/maintenance/work-orders/${selectedWorkOrderId}`, {
              method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "complete" }),
            }), "Maintenance work order completed.")}>Complete</Button>}
          {canManage && selectedOrderStatus === "completed" && <Button disabled={busy} onClick={() => void run(() =>
            api(`/api/operations/maintenance/work-orders/${selectedWorkOrderId}`, {
              method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "close" }),
            }), "Maintenance work order closed.")}>Close work order</Button>}
          {canManage && selectedOrderStatus === "scheduled" && <Button tone="secondary" disabled={busy} onClick={() => void run(() =>
            api(`/api/operations/maintenance/work-orders/${selectedWorkOrderId}`, {
              method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }),
            }), "Maintenance work order cancelled.")}>Cancel</Button>}
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <section aria-labelledby="checklist-title">
            <h3 id="checklist-title" className="mb-2 text-sm font-bold">Checklist</h3>
            <div className="space-y-2">
              {selectedChecklist.map((item) => <div key={String(item.id)} className="flex flex-wrap items-center gap-2 rounded border p-2 text-xs">
                <span className="min-w-[180px] flex-1">{String(item.label)}{item.required ? " *" : ""}</span>
                {selectedOrderStatus === "scheduled" || selectedOrderStatus === "in_progress" ? <select aria-label={`Result for ${String(item.label)}`}
                  value={String(item.result)} onChange={(event) => void run(() => api(
                    `/api/operations/maintenance/work-orders/${selectedWorkOrderId}/checklist/${String(item.id)}`,
                    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ result: event.target.value }) },
                  ), "Checklist result saved.")} className="h-9 rounded border bg-white px-2">
                  {["pending","pass","fail","not_applicable"].map((result) => <option key={result} value={result}>{result.replace("_"," ")}</option>)}
                </select> : <strong>{String(item.result)}</strong>}
              </div>)}
              {!selectedChecklist.length && <p className="text-xs text-slate-500">No checklist steps are required.</p>}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-bold">Parts issued / returned</h3>
            {(selectedOrderStatus === "in_progress" || selectedOrderStatus === "completed") && <form className="grid gap-2 sm:grid-cols-2" onSubmit={submit(async (values) => {
              await api(`/api/operations/maintenance/work-orders/${selectedWorkOrderId}/parts`, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  action: values.action, sku: values.sku, quantity: values.quantity, location: values.location,
                  bin: values.bin, unitCost: values.unitCost || undefined, notes: values.notes,
                  idempotencyKey: crypto.randomUUID(),
                }),
              });
            }, "Inventory and maintenance part history updated.")}>
              <Select label="Action" name="action" required options={[{ value: "used", label: "Issue part" },{ value: "returned", label: "Return part" }]}/>
              <Select label="Inventory item" name="sku" required options={options.items.map((item) => ({ value: String(item.sku), label: `${String(item.sku)} · ${String(item.name)}` }))}/>
              <Field label="Quantity" name="quantity" type="number" min="0.001" step="0.001" required/>
              <Field label="Unit cost (for issues)" name="unitCost" type="number" min="0" step="0.0001"/>
              <Field label="Warehouse location" name="location" required/>
              <Field label="Bin" name="bin" required/>
              <div className="sm:col-span-2"><Button type="submit" disabled={busy}>Record inventory movement</Button></div>
            </form>}
            {canManage && (selectedOrderStatus === "in_progress" || selectedOrderStatus === "completed") && <form className="mt-3 grid gap-2 sm:grid-cols-2"
              onSubmit={submit(async (values) => {
                await api(`/api/operations/maintenance/work-orders/${selectedWorkOrderId}/costs`, {
                  method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    costType: values.costType, description: values.description, amount: values.amount,
                    idempotencyKey: crypto.randomUUID(),
                  }),
                });
              }, "Maintenance cost entry recorded.")}>
              <Select label="Cost type" name="costType" required options={[{ value: "labor", label: "Labor" },{ value: "other", label: "Other" }]}/>
              <Field label="Amount" name="amount" type="number" min="0" step="0.0001" required/>
              <label className="text-xs font-semibold sm:col-span-2">Description<input name="description" required className="mt-1 h-9 w-full rounded-md border px-2"/></label>
              <div className="sm:col-span-2"><Button type="submit" disabled={busy}>Add cost</Button></div>
            </form>}
            <div className="mt-3 space-y-1 text-xs">
              {selectedParts.map((part) => <p key={String(part.id)} className="border-b py-1">
                {String(part.action)} {String(part.quantity)} {String(part.unit)} {String(part.sku)} · {String(part.location)}/{String(part.bin)} · ${Number(part.unitCost).toFixed(4)} per unit
              </p>)}
              {!selectedParts.length && <p className="text-slate-500">No inventory parts recorded.</p>}
            </div>
            <h4 className="mb-1 mt-4 text-xs font-bold">Cost ledger</h4>
            {selectedCosts.map((cost) => <p key={String(cost.id)} className="border-b py-1 text-xs">
              {String(cost.costType)} · {String(cost.description)} · ${Number(cost.amount).toFixed(2)}
            </p>)}
          </section>
        </div>
        <section className="mt-5">
          <h3 className="mb-2 text-sm font-bold">Maintenance work-order history</h3>
          <ol className="space-y-1 text-xs">
            {selectedEvents.map((event) => <li key={String(event.id)} className="border-l-2 border-slate-300 py-1 pl-3">
              {formatDisplayLabel(String(event.eventType))} · {format(event.createdAt)} · {String(event.actor)}
            </li>)}
          </ol>
        </section>
      </Panel>}

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title={`Equipment downtime · ${selectedAsset?.assetTag ?? "select equipment"}`}>
          {canManage && selectedAsset && <form className="grid gap-3 md:grid-cols-2" onSubmit={submit(async (values) => {
            await api(`/api/operations/equipment/${selectedAsset.id}/downtime`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({
                reason: values.reason, notes: values.notes,
                startedAt: values.startedAt ? new Date(String(values.startedAt)).toISOString() : undefined,
                endedAt: values.endedAt ? new Date(String(values.endedAt)).toISOString() : undefined,
                maintenanceWorkOrderId: values.maintenanceWorkOrderId || null,
                productionDowntimeId: values.productionDowntimeId || null,
                idempotencyKey: crypto.randomUUID(),
              }),
            });
          }, "Equipment downtime recorded or linked.")}>
            <Field label="Reason" name="reason" required/>
            <Select label="Repair work order" name="maintenanceWorkOrderId" options={ordersForAsset.map((order) => ({ value: order.id, label: `${order.title} · ${order.status}` }))}/>
            <Field label="Existing production downtime ID (optional link)" name="productionDowntimeId"/>
            <Field label="Started at (leave end empty for ongoing)" name="startedAt" type="datetime-local"/>
            <Field label="Ended at" name="endedAt" type="datetime-local"/>
            <label className="text-xs font-semibold md:col-span-2">Notes<input name="notes" className="mt-1 h-10 w-full rounded-md border px-2"/></label>
            <div className="md:col-span-2"><Button type="submit" disabled={busy}>Record downtime</Button></div>
          </form>}
          <div className="mt-4 max-h-64 space-y-2 overflow-auto">
            {selectedDowntime.map((event) => <div key={String(event.id)} className="flex flex-wrap items-center justify-between gap-2 rounded border p-3 text-xs">
              <div><strong>{String(event.reason)}</strong><p className="mt-1 text-slate-500">{format(event.startedAt)} → {format(event.endedAt)} · {String(event.source)}</p></div>
              {!event.endedAt && canManage && <Button tone="secondary" disabled={busy} onClick={() => void run(() =>
                api(`/api/operations/equipment/${selectedAssetId}/downtime/${String(event.id)}`, {
                  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
                }), "Equipment downtime closed.")}>Close interval</Button>}
              {Boolean(event.productionDowntimeId) && <span className="text-teal-800">Linked to production downtime</span>}
              {Boolean(event.maintenanceWorkOrderId) && <span className="text-teal-800">Linked to maintenance repair</span>}
            </div>)}
            {!selectedDowntime.length && <p className="text-xs text-slate-500">No equipment downtime recorded. Production downtime for linked jobs is included in reliability analytics automatically.</p>}
          </div>
        </Panel>

        <Panel title="Reliability and failure history">
          <label className="mb-4 block text-xs font-semibold">Window
            <select value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value))}
              className="ml-2 h-9 rounded-md border bg-white px-2">
              {[7,30,90,365].map((days) => <option key={days} value={days}>{days} days</option>)}
            </select>
          </label>
          <div className="max-h-[500px] space-y-3 overflow-auto">
            {(analytics?.equipment ?? []).filter((entry) => !selectedAssetId || entry.assetId === selectedAssetId).map((entry) => <article key={entry.assetId} className="rounded-lg border p-4">
              <h3 className="font-bold">{entry.assetTag} · {entry.name}</h3>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div className="rounded bg-slate-50 p-2"><span className="text-slate-500">Availability</span><strong className="mt-1 block">{entry.metrics.availabilityPercent.toFixed(2)}%</strong></div>
                <div className="rounded bg-slate-50 p-2"><span className="text-slate-500">MTBF</span><strong className="mt-1 block">{seconds(entry.metrics.mtbfSeconds)}</strong></div>
                <div className="rounded bg-slate-50 p-2"><span className="text-slate-500">MTTR</span><strong className="mt-1 block">{seconds(entry.metrics.mttrSeconds)}</strong></div>
                <div className="rounded bg-slate-50 p-2"><span className="text-slate-500">Downtime</span><strong className="mt-1 block">{seconds(entry.metrics.downtimeSeconds)}</strong></div>
              </div>
              <p className="mt-2 text-[10px] text-slate-500">{entry.metrics.failureCount} failure interval(s) started in the {analytics?.days}-day window.</p>
              <ol className="mt-3 space-y-1 text-xs">
                {entry.failureHistory.slice(0, 8).map((failure) => <li key={String(failure.id)} className="border-l-2 border-amber-400 pl-2">
                  {String(failure.reason)} · {format(failure.startedAt)} → {format(failure.endedAt)}
                  {Boolean(failure.productionJobCode) ? ` · production ${String(failure.productionJobCode)} (${String(failure.productionStatus)})` : ""}
                  {Boolean(failure.maintenanceTitle) ? ` · repair ${String(failure.maintenanceTitle)}` : ""}
                </li>)}
                {!entry.failureHistory.length && <li className="text-slate-500">No failures or downtime in this window.</li>}
              </ol>
            </article>)}
            {!analytics?.equipment.length && <p className="text-xs text-slate-500">No equipment records are available for this account.</p>}
          </div>
          <p className="mt-3 text-[10px] text-slate-500">
            MTBF = in-window uptime / downtime intervals started in the window. MTTR = average full duration of intervals closed in the window.
            Availability uses the union of clipped downtime intervals, so overlapping records are not double-counted. These are historical metrics, not OEE or predictive forecasts.
          </p>
        </Panel>
      </div>

      <p className="rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-600">
        Telemetry retains its simulator or gateway source, quality, ordering, observation, and receipt metadata. Stale, bad-quality, delayed, or disconnected samples are not represented as current live equipment status.
      </p>
    </div>
  </main>;
}
