"use client";

import { useMemo, useState, type FormEvent } from "react";
import { FileCode2, FilePenLine, Plus, UploadCloud, X } from "lucide-react";

type Row = Record<string, unknown>;
type Kind = "plc" | "hmi" | "electrical_schematic" | "mechanical_schematic";

const CATEGORY_ACTIONS: { kind: Kind; label: string; title: string }[] = [
  { kind: "plc", label: "Upload PLC Code", title: "PLC Code" },
  { kind: "hmi", label: "Upload HMI Code", title: "HMI Code" },
  { kind: "electrical_schematic", label: "Upload Electrical Schematics", title: "Electrical Schematics" },
  { kind: "mechanical_schematic", label: "Upload Mechanical Schematics", title: "Mechanical Schematics" },
];

async function post(url: string, body: BodyInit, headers?: HeadersInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: "POST", body, headers, credentials: "same-origin", cache: "no-store" });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Request failed.");
  return result;
}

export default function EngineeringUploadPanel({
  projects, assets, onCreated, onEquipmentAdded,
}: {
  projects: Row[];
  assets: Row[];
  onCreated: (documentId: string) => Promise<void>;
  onEquipmentAdded: () => Promise<void>;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [projectId, setProjectId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [addingEquipment, setAddingEquipment] = useState(false);
  const [localAssets, setLocalAssets] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const availableEquipment = useMemo(() => {
    const map = new Map<string, Row>();
    for (const asset of [...assets, ...localAssets]) map.set(String(asset.id), asset);
    return [...map.values()].filter((asset) =>
      !projectId || !asset.project_id || asset.project_id === projectId);
  }, [assets, localAssets, projectId]);

  async function addEquipment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const values = Object.fromEntries(fields.entries());
    const payload = {
      ...values,
      ...(projectId ? { project_id: projectId } : {}),
    };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const record = await post("/api/operations/assets", JSON.stringify(payload), {
        "Content-Type": "application/json",
      });
      const newId = String(record.id);
      const asset = { ...payload, id: newId };
      setLocalAssets((prior) => [...prior, asset]);
      setAssetId(newId);
      setAddingEquipment(false);
      setNotice("Equipment created and selected. You can now upload its engineering file.");
      await onEquipmentAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add equipment.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadInitialFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!kind) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    data.set("kind", kind);
    if (projectId) data.set("projectId", projectId);
    if (assetId) data.set("assetId", assetId);

    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await post("/api/engineering/uploads", data);
      const documentId = String(result.documentId);
      await onCreated(documentId);
      form.reset();
      setNotice("Engineering file uploaded as revision 1 (draft). An administrator must approve its release.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Engineering file upload failed.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "mt-1 block w-full min-h-10 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm";
  const categoryLabel = CATEGORY_ACTIONS.find((item) => item.kind === kind)?.title;

  return <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
    <div>
      <h2 className="text-lg font-bold">Engineering File Uploads</h2>
      <p className="text-sm text-slate-500 mt-1">
        Upload actual PLC/HMI project files or electrical/mechanical drawings. Files are stored unchanged with controlled revisions.
      </p>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      {CATEGORY_ACTIONS.map((action) =>
        <button key={action.kind} type="button" disabled={busy}
          onClick={() => {
            setKind(action.kind);
            setAddingEquipment(false);
            setError("");
            setNotice("");
          }}
          className={"rounded-lg border px-4 py-4 text-sm font-semibold flex gap-2 items-center text-left " +
            (kind === action.kind ? "bg-teal-800 text-white border-teal-800" :
              "border-teal-200 bg-teal-50 text-teal-900 hover:bg-teal-100")}>
          {action.kind === "plc" || action.kind === "hmi" ? <FileCode2 size={20}/> : <FilePenLine size={20}/>}
          {action.label}
        </button>)}
    </div>

    {error && <p role="alert" className="rounded-lg bg-rose-50 border border-rose-200 p-3 text-sm text-rose-800">{error}</p>}
    {notice && <p role="status" className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-900">{notice}</p>}

    {kind && <>
      <div className="flex justify-between items-center">
        <h3 className="font-bold text-base">Upload {categoryLabel}</h3>
        <button type="button" onClick={() => setKind(null)} className="text-slate-600 flex gap-1 items-center text-xs">
          <X size={14}/> Close
        </button>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <label className="block text-sm font-semibold">Project
          <select value={projectId} onChange={(event) => {
            setProjectId(event.target.value);
            setAssetId("");
          }} className={inputClass}>
            <option value="">Select Project (optional if equipment is selected)</option>
            {projects.map((project) =>
              <option key={String(project.id)} value={String(project.id)}>
                {String(project.code)} · {String(project.name)}
              </option>)}
          </select>
        </label>

        <div>
          <label className="block text-sm font-semibold">Equipment
            <select value={assetId} onChange={(event) => setAssetId(event.target.value)} className={inputClass}>
              <option value="">Select Equipment (optional for project documents)</option>
              {availableEquipment.map((asset) =>
                <option key={String(asset.id)} value={String(asset.id)}>
                  {String(asset.asset_tag)} · {String(asset.name)}
                </option>)}
            </select>
          </label>
          <button type="button" onClick={() => setAddingEquipment((value) => !value)}
            className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-teal-800 hover:underline"
            disabled={busy}>
            <Plus size={14}/> {addingEquipment ? "Cancel Equipment Registration" : "Add Equipment Here"}
          </button>
          {!availableEquipment.length && <p className="text-xs text-slate-500 mt-1">
            No equipment records are available for this selection. Add equipment here or upload against the project.
          </p>}
        </div>
      </div>

      {addingEquipment && <form onSubmit={(event) => void addEquipment(event)}
        className="rounded-lg border border-teal-200 bg-teal-50/60 p-4 grid md:grid-cols-3 gap-3">
        <p className="md:col-span-3 font-bold text-sm">Register Equipment Without Leaving This Screen</p>
        <label className="text-xs font-semibold">Asset Tag *
          <input name="asset_tag" maxLength={80} minLength={2} required className={inputClass} placeholder="MFR-SAND-001"/>
        </label>
        <label className="text-xs font-semibold">Equipment Name *
          <input name="name" maxLength={200} minLength={2} required className={inputClass} placeholder="Sanding Robot"/>
        </label>
        <label className="text-xs font-semibold">Customer Site *
          <input name="customer_site" maxLength={200} minLength={2} required className={inputClass} placeholder="Customer facility"/>
        </label>
        <label className="text-xs font-semibold">PLC Manufacturer
          <input name="plc_make" maxLength={100} className={inputClass}/>
        </label>
        <label className="text-xs font-semibold">PLC Model
          <input name="plc_model" maxLength={100} className={inputClass}/>
        </label>
        <label className="text-xs font-semibold">HMI Model
          <input name="hmi_model" maxLength={100} className={inputClass}/>
        </label>
        <button disabled={busy} type="submit" className="md:col-span-3 justify-self-start rounded-md bg-teal-800 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50">
          Save Equipment & Select It
        </button>
      </form>}

      <form onSubmit={(event) => void uploadInitialFile(event)} className="grid md:grid-cols-2 gap-4">
        <label className="block text-sm font-semibold">Program / Drawing Title *
          <input name="title" required minLength={2} maxLength={200} className={inputClass}
            placeholder={kind === "plc" ? "Sanding Robot PLC Program" :
              kind === "hmi" ? "Sanding Robot HMI Project" :
                kind === "electrical_schematic" ? "Sanding Robot Electrical Schematics" : "Sanding Robot Mechanical Schematics"}/>
        </label>
        <label className="block text-sm font-semibold">Actual Engineering File *
          <input name="file" type="file" required className={inputClass}/>
        </label>
        <label className="block text-sm font-semibold md:col-span-2">Revision 1 — Change Notes
          <textarea name="notes" maxLength={1000} rows={2} className={inputClass}
            placeholder="Initial engineering issue; changes, controller version, or drawing references"/>
        </label>
        <div className="md:col-span-2 flex flex-wrap items-center gap-4">
          <button type="submit" disabled={busy || (!projectId && !assetId)}
            className="inline-flex gap-2 items-center rounded-md bg-teal-800 px-4 py-2 text-white text-sm font-semibold disabled:opacity-40">
            <UploadCloud size={17}/> {busy ? "Saving…" : "Upload Engineering File"}
          </button>
          <p className="text-xs text-slate-500">
            Up to 50 MB per file. Native files are preserved, and the initial revision is a draft pending approval.
          </p>
        </div>
      </form>
    </>}
  </section>;
}
