"use client";

import Link from "next/link";
import EngineeringUploadPanel from "@/components/engineering-upload-panel";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { formatDisplayLabel } from "@/lib/display-label";
import { Boxes, LayoutDashboard, FolderKanban, Wrench, Factory, Package,
  ClipboardList, Truck, FileCode2, RefreshCcw, Plus, CheckCircle2, ChevronRight,
  ArrowLeft, AlertCircle, Download, UploadCloud, LogOut, ShieldCheck } from "lucide-react";

type Resource="projects"|"tasks"|"assets"|"bom"|"documents"|"production"|"purchasing"|"service";
type RecordRow=Record<string,unknown>;
type Overview=Record<Resource,RecordRow[]>;
type User={id:string;email:string;displayName:string;role:"admin"|"operator"|"viewer"};
type Field={name:string;label:string;type?:"text"|"number"|"date"|"textarea"|"select";required?:boolean;options?:string[]};
type Module={label:string;description:string;fields:Field[];columns:string[]};
type Revision={id:string;revision:number;file_name:string;status:string;sha256:string;byte_size:number;created_at:string};
type Release={id:string;document_id:string;revision:number;file_name:string;title:string;kind:string;project_id:string|null;asset_id:string|null;asset_tag:string|null};
type Event={id:string;kind:string;quantity:string;notes:string;created_at:string;actor_name:string;sku:string|null};
type Install={id:string;result:string;notes:string;performed_at:string;document_title:string;revision:number;file_name:string;technician:string};

const field=(name:string,label:string,required=false,type:Field["type"]="text",options?:string[]):Field=>({name,label,required,type,options});
const MODULES:Record<Resource,Module>={
  projects:{label:"Projects",description:"Customer jobs, delivery milestones, and work ownership",
    columns:["code","name","customer","priority","status","due_date"],
    fields:[field("code","Project code",true),field("name","Project name",true),field("customer","Customer",true),
      field("description","Description",false,"textarea"),field("priority","Priority",false,"select",["normal","high","low"]),
      field("due_date","Due date",false,"date")]},
  tasks:{label:"Tasks & milestones",description:"Engineering and cross-department actions linked to projects",
    columns:["project_code","title","discipline","status","due_date"],
    fields:[field("project_id","Project",true,"select"),field("title","Task or milestone",true),
      field("discipline","Team",true,"select",["engineering","project","production","field_service"]),
      field("due_date","Target date",false,"date"),field("notes","Instructions",false,"textarea")]},
  assets:{label:"Equipment & engineering",description:"Machine identity, PLC/HMI models, and customer site mapping",
    columns:["asset_tag","name","customer_site","plc_make","plc_model","hmi_model"],
    fields:[field("project_id","Project",false,"select"),field("asset_tag","Asset tag",true),field("name","Equipment name",true),
      field("customer_site","Customer site",true),field("area","Area / line"),field("plc_make","PLC manufacturer"),
      field("plc_model","PLC model"),field("hmi_make","HMI manufacturer"),field("hmi_model","HMI model"),
      field("notes","Engineering notes",false,"textarea")]},
  bom:{label:"Engineering BOM",description:"Approved material requirements linked to inventory SKUs and projects",
    columns:["project_code","sku","item_name","required_qty","unit","revision"],
    fields:[field("project_id","Project",true,"select"),field("sku","Inventory SKU",true,"select"),
      field("required_qty","Required quantity",true,"number"),field("revision","Engineering revision"),
      field("notes","Notes",false,"textarea")]},
  documents:{label:"Drawing & PLC/HMI Library",description:"Controlled documents, upload history, release approvals, and field downloads",
    columns:["title","kind","project_code","asset_tag","revisions","approved_revision"],
    fields:[field("project_id","Project",false,"select"),field("asset_id","Equipment",false,"select"),
      field("title","Document / program title",true),
      field("kind","Document type",true,"select",["drawing","spec","bom","manual","sop","plc","hmi","other"])]},
  production:{label:"Production floor",description:"Jobs, progress, scrap, pauses, and audited materials issued to production",
    columns:["job_code","project_code","title","planned_qty","completed_qty","scrap_qty","status"],
    fields:[field("project_id","Project",true,"select"),field("asset_id","Equipment",false,"select"),
      field("job_code","Production job code",true),field("title","Work description",true),
      field("planned_qty","Planned units",true,"number"),field("due_date","Due date",false,"date")]},
  purchasing:{label:"Purchasing",description:"Project-linked material purchasing requests using the inventory catalog",
    columns:["project_code","sku","item_name","quantity","supplier","status"],
    fields:[field("project_id","Project",false,"select"),field("sku","Inventory SKU",true,"select"),
      field("quantity","Required quantity",true,"number"),field("supplier","Supplier"),
      field("reference","Purchase reference"),field("needed_by","Required by",false,"date")]},
  service:{label:"Field service",description:"Customer equipment jobs and records of approved controller program installations",
    columns:["asset_tag","customer_site","title","technician_name","status","scheduled_date"],
    fields:[field("project_id","Project",false,"select"),field("asset_id","Equipment",true,"select"),
      field("title","Field service scope",true),field("scheduled_date","Scheduled date",false,"date"),
      field("notes","Instructions",false,"textarea")]},
};
const ORDER:Resource[]=["projects","tasks","assets","bom","documents","production","purchasing","service"];
const transitions:Partial<Record<Resource,Record<string,string[]>>>={
  projects:{planned:["active","on_hold"],active:["on_hold","completed"],on_hold:["active","completed"]},
  tasks:{todo:["in_progress","blocked","done"],in_progress:["blocked","done"],blocked:["in_progress","done"]},
  purchasing:{requested:["ordered","cancelled"],ordered:["received","cancelled"]},
  service:{open:["scheduled","in_progress"],scheduled:["in_progress","completed"],in_progress:["completed"]},
};
const titleize=formatDisplayLabel;
const engineeringKindLabel=(value:unknown)=>value==="electrical_schematic"?"Electrical Schematics":
  value==="mechanical_schematic"?"Mechanical Schematics":titleize(String(value??""));
const display=(value:unknown)=>{
  if(value===null||value===undefined||value==="")return "—";
  if(typeof value==="string"&&/^\d{4}-\d\d-\d\dT/.test(value))return new Date(value).toLocaleDateString();
  return String(value);
};
async function request<T>(url:string,options?:RequestInit):Promise<T>{
  const response=await fetch(url,{...options,credentials:"same-origin",cache:"no-store"});
  const data=await response.json() as T & {error?:string};
  if(!response.ok)throw new Error(data.error??"Request failed.");
  return data;
}
const Panel=({children,className=""}:{children:React.ReactNode;className?:string})=>
  <section className={"rounded-xl bg-white border border-slate-200 shadow-sm "+className}>{children}</section>;
const Button=({children,disabled=false,onClick,type="button",tone="primary"}:{
  children:React.ReactNode;disabled?:boolean;onClick?:()=>void;type?:"button"|"submit";tone?:"primary"|"ghost";
})=><button type={type} disabled={disabled} onClick={onClick}
  className={(tone==="primary"?"bg-teal-700 hover:bg-teal-800 text-white":"bg-white text-slate-700 border border-slate-300 hover:bg-slate-50")+
    " inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-semibold disabled:opacity-40"}>
  {children}</button>;

export default function OperationsWorkspace(){
  const router=useRouter();
  const [user,setUser]=useState<User|null>(null);
  const [loading,setLoading]=useState(true);
  const [overview,setOverview]=useState<Overview|null>(null);
  const [stock,setStock]=useState<{sku:string;name:string}[]>([]);
  const [releases,setReleases]=useState<Release[]>([]);
  const [schematics,setSchematics]=useState<Release[]>([]);
  const [active,setActive]=useState<Resource>("projects");
  const [showForm,setShowForm]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [focusedDoc,setFocusedDoc]=useState<string|null>(null);
  const [revisions,setRevisions]=useState<Revision[]>([]);
  const [focusedJob,setFocusedJob]=useState<string|null>(null);
  const [events,setEvents]=useState<Event[]>([]);
  const [focusedService,setFocusedService]=useState<string|null>(null);
  const [installs,setInstalls]=useState<Install[]>([]);
  const [productionAction,setProductionAction]=useState("start");

  const refresh=useCallback(async()=>{
    const [data,items,approved,approvedSchematics]=await Promise.all([
      request<Overview>("/api/operations/overview"),
      request<{items:{sku:string;name:string}[]}>("/api/inventory"),
      request<{releases:Release[]}>("/api/engineering/releases"),
      request<{files:Release[]}>("/api/engineering/field-schematics"),
    ]);
    setOverview(data);
    setStock([...new Map(items.items.map(x=>[x.sku,x])).values()]);
    setReleases(approved.releases);
    setSchematics(approvedSchematics.files);
  },[]);

  useEffect(()=>{
    let mounted=true;
    void request<{user:User|null}>("/api/auth/status")
      .then(async result=>{
        if(!mounted)return;
        setUser(result.user);
        if(result.user)await refresh();
      }).catch(e=>{if(mounted)setError(e instanceof Error?e.message:"Unable to load workspace");})
      .finally(()=>{if(mounted)setLoading(false);});
    return ()=>{mounted=false;};
  },[refresh]);

  const rows=overview?.[active]??[];
  const editable=user?.role==="admin"||user?.role==="operator";
  const options=useMemo(()=>({
    project_id:(overview?.projects??[]).map(r=>({value:String(r.id),label:String(r.code)+" · "+String(r.name)})),
    asset_id:(overview?.assets??[]).map(r=>({value:String(r.id),label:String(r.asset_tag)+" · "+String(r.name)})),
    sku:stock.map(r=>({value:r.sku,label:r.sku+" · "+r.name})),
  }),[overview,stock]);

  async function perform(action:()=>Promise<void>,success:string){
    setBusy(true);setError("");setNotice("");
    try{await action();await refresh();setNotice(success);}
    catch(e){setError(e instanceof Error?e.message:"Unable to save changes.");}
    finally{setBusy(false);}
  }

  async function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const payload=Object.fromEntries([...form.entries()].filter(([,value])=>value!==""));
    await perform(async()=>{
      await request("/api/operations/"+active,{
        method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),
      });
      setShowForm(false);
    },MODULES[active].label+" record created.");
  }

  async function changeStatus(resource:Resource,id:string,status:string){
    await perform(async()=>{
      await request("/api/operations/"+resource+"/"+id,{
        method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status}),
      });
    },"Status changed to "+titleize(status)+".");
  }

  async function inspectDocument(id:string){
    setFocusedDoc(id);setError("");
    try{const r=await request<{revisions:Revision[]}>("/api/engineering/documents/"+id+"/revisions");setRevisions(r.revisions);}
    catch(e){setError(e instanceof Error?e.message:"Unable to load revisions.");}
  }
  async function upload(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!focusedDoc)return;
    const data=new FormData(event.currentTarget);
    await perform(async()=>{
      await request("/api/engineering/documents/"+focusedDoc+"/revisions",{method:"POST",body:data});
      await inspectDocument(focusedDoc);
    },"New revision uploaded as a draft. An administrator must approve it for field use.");
  }
  async function approve(id:string){
    await perform(async()=>{
      await request("/api/engineering/revisions/"+id,{method:"PATCH"});
      if(focusedDoc)await inspectDocument(focusedDoc);
    },"Release approved. Prior approved revision is now superseded.");
  }
  async function inspectProduction(id:string){
    setFocusedJob(id);setError("");
    try{const r=await request<{events:Event[]}>("/api/operations/production/"+id+"/events");setEvents(r.events);}
    catch(e){setError(e instanceof Error?e.message:"Unable to load production history.");}
  }
  async function addProductionEvent(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!focusedJob)return;
    const payload=Object.fromEntries([...new FormData(event.currentTarget).entries()].filter(([,v])=>v!==""));
    await perform(async()=>{
      await request("/api/operations/production/"+focusedJob+"/events",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({...payload,kind:productionAction,idempotencyKey:crypto.randomUUID()}),
      });
      await inspectProduction(focusedJob);
    },"Production event recorded and inventory updated where applicable.");
  }
  async function inspectService(id:string){
    setFocusedService(id);setError("");
    try{const r=await request<{installs:Install[]}>("/api/operations/service/"+id+"/installs");setInstalls(r.installs);}
    catch(e){setError(e instanceof Error?e.message:"Unable to load service history.");}
  }
  async function recordInstall(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!focusedService)return;
    const body=Object.fromEntries(new FormData(event.currentTarget).entries());
    await perform(async()=>{
      await request("/api/operations/service/"+focusedService+"/installs",{
        method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
      });
      await inspectService(focusedService);
    },"Controller installation record added to service history.");
  }
  const selectedDocument=overview?.documents.find(x=>x.id===focusedDoc);
  const selectedProduction=overview?.production.find(x=>x.id===focusedJob);
  const selectedService=overview?.service.find(x=>x.id===focusedService);
  const matchingReleases=releases.filter(r=>r.asset_id===selectedService?.asset_id ||
    (r.asset_id===null && r.project_id!==null && r.project_id===selectedService?.project_id));
  const matchingSchematics=schematics.filter(r=>r.asset_id===selectedService?.asset_id ||
    (r.asset_id===null && r.project_id!==null && r.project_id===selectedService?.project_id));

  if(loading)return <main className="min-h-screen grid place-items-center bg-slate-100 text-slate-600">Connecting to CloudForge operations…</main>;
  if(!user)return <main className="min-h-screen grid place-items-center bg-slate-100 p-5">
    <Panel className="max-w-md p-8 text-center"><ShieldCheck size={36} className="mx-auto text-teal-700 mb-4"/>
      <h1 className="text-2xl font-bold">CloudForge Operations</h1>
      <p className="text-slate-500 mt-3 mb-6">Sign in to access your organization&apos;s protected engineering and production records.</p>
      <Link href="/" className="text-teal-700 font-semibold underline">Go to sign in</Link>
      {error&&<p className="mt-3 text-rose-700">{error}</p>}
    </Panel>
  </main>;

  return <div className="min-h-screen bg-[#f4f6f5] text-slate-800 lg:flex">
    <aside className="bg-[#16272b] text-slate-200 lg:w-64 shrink-0 p-5 flex flex-col gap-3">
      <div className="flex items-center gap-3 mb-6"><div className="p-2 bg-teal-200 text-teal-900 rounded-lg"><Boxes size={22}/></div>
        <div><strong className="block tracking-tight text-lg">CloudForge</strong><span className="text-[11px] text-slate-400">Industrial Operations</span></div></div>
      <Link href="/" className="flex items-center gap-2 p-3 text-sm rounded-md hover:bg-slate-700"><Package size={17}/> Inventory (Phase 1)</Link>
      <Link href="/operations/phase3" className="flex items-center gap-2 p-3 text-sm rounded-md hover:bg-slate-700"><Factory size={17}/> Phase 3 workflows</Link>
      <Link href="/operations/equipment" className="flex items-center gap-2 p-3 text-sm rounded-md hover:bg-slate-700"><Wrench size={17}/> Phase 4 equipment</Link>
      <div className="text-[10px] tracking-widest uppercase text-slate-500 font-bold mt-3 mb-1">Integrated operations</div>
      <nav className="flex flex-row lg:flex-col flex-wrap gap-1" aria-label="Operations modules">
        {ORDER.map(k=><button key={k} onClick={()=>{setActive(k);setShowForm(false);setError("");setNotice("");}}
          className={"rounded-md p-3 text-xs font-semibold text-left flex items-center gap-2 "+
            (active===k?"bg-teal-800 text-white":"hover:bg-[#2b4144] text-slate-300")}>
          {k==="projects"?<FolderKanban size={16}/>:k==="production"?<Factory size={16}/>:
           k==="service"?<Truck size={16}/>:k==="documents"?<FileCode2 size={16}/>:
           k==="assets"?<Wrench size={16}/>:k==="purchasing"?<ClipboardList size={16}/>:
           k==="bom"?<Package size={16}/>:<LayoutDashboard size={16}/>}
          {MODULES[k].label}</button>)}
      </nav>
      <div className="mt-auto pt-6 border-t border-slate-700 text-xs text-slate-300">
        <strong className="block">{user.displayName}</strong><span>{titleize(user.role)} · single-organization deployment</span>
        <button className="flex items-center gap-2 mt-3 text-slate-400 hover:text-white" onClick={()=>void perform(async()=>{
          await request("/api/auth/logout",{method:"POST"});
          router.push("/");
        },"Signed out.")}><LogOut size={14}/> Sign out</button>
      </div>
    </aside>

    <main className="flex-1 min-w-0">
      <header className="bg-white border-b border-slate-200 px-5 lg:px-9 py-4 flex flex-wrap justify-between gap-4 items-center">
        <div><p className="text-[11px] font-bold tracking-widest text-teal-700 uppercase">CloudForge Core · Phase 2</p>
          <h1 className="text-2xl font-bold">{MODULES[active].label}</h1>
          <p className="text-xs text-slate-500 mt-1">{MODULES[active].description}</p></div>
        <div className="flex gap-2"><Button tone="ghost" onClick={()=>void perform(refresh,"Workspace refreshed.")} disabled={busy}><RefreshCcw size={14}/> Refresh</Button>
          {editable&&active!=="documents"&&<Button onClick={()=>setShowForm(v=>!v)} disabled={busy}><Plus size={15}/> New record</Button>}</div>
      </header>

      <div className="p-5 lg:p-9 max-w-[1600px] mx-auto space-y-6">
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[["Projects",overview?.projects.length??0],["Engineering documents",overview?.documents.length??0],
            ["Production jobs",overview?.production.length??0],["Service jobs",overview?.service.length??0]].map(([label,value])=>
            <Panel className="px-5 py-4" key={String(label)}>
              <div className="text-xs text-slate-500">{label}</div>
              <div className="text-2xl font-bold mt-1">{value}</div></Panel>)}
        </section>

        {error&&<div role="alert" className="bg-rose-50 border border-rose-200 rounded-lg p-4 flex gap-2 text-sm text-rose-800">
          <AlertCircle size={18}/>{error}</div>}
        {notice&&<div role="status" className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 flex gap-2 text-sm text-emerald-900">
          <CheckCircle2 size={18}/>{notice}</div>}

        {active==="documents"&&editable&&<EngineeringUploadPanel
          projects={overview?.projects??[]} assets={overview?.assets??[]}
          onCreated={async(id)=>{await refresh();await inspectDocument(id);}}
          onEquipmentAdded={refresh}
        />}

        {showForm&&editable&&<Panel className="p-6">
          <h2 className="font-bold text-lg mb-4">{titleize(`Create ${MODULES[active].label} record`)}</h2>
          <form onSubmit={event=>void create(event)} className="grid md:grid-cols-2 gap-4">
            {MODULES[active].fields.map(f=><label key={f.name} className={"text-xs font-semibold text-slate-700 "+(f.type==="textarea"?"md:col-span-2":"")}>
              <span className="block mb-1.5">{f.label}{f.required?" *":""}</span>
              {f.type==="select"?<select name={f.name} required={f.required} defaultValue=""
                className="w-full h-10 p-2 rounded-md border border-slate-300 bg-white text-sm">
                <option value="">Select {f.label}</option>
                {(f.options?.map(x=>({value:x,label:titleize(x)})) ??
                  (options[f.name as keyof typeof options]??[])).map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>:f.type==="textarea"?<textarea name={f.name} rows={3} required={f.required}
                className="w-full p-2 rounded-md border border-slate-300 text-sm"/>:
                <input name={f.name} type={f.type==="number"?"number":f.type==="date"?"date":"text"}
                  required={f.required} min={f.type==="number"?"0.001":undefined} step={f.type==="number"?"0.001":undefined}
                  className="w-full h-10 p-2 rounded-md border border-slate-300 text-sm"/>}
            </label>)}
            <div className="md:col-span-2 flex gap-2"><Button type="submit" disabled={busy}>Save record</Button>
              <Button tone="ghost" onClick={()=>setShowForm(false)}>Cancel</Button></div>
          </form>
          {(active==="bom"||active==="purchasing")&&<p className="text-xs mt-4 text-slate-500">Use an existing Phase 1 inventory SKU. Purchase requests do not automatically receive stock.</p>}
        </Panel>}

        <Panel className="overflow-hidden">
          <div className="p-5 flex justify-between items-center border-b border-slate-100">
            <h2 className="font-bold">{MODULES[active].label} <span className="text-slate-400 font-normal">({rows.length})</span></h2>
            <span className="text-xs text-slate-400">Live database records</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] tracking-wider">
                <tr>{MODULES[active].columns.map(x=><th key={x} className="px-4 py-3 whitespace-nowrap">{titleize(x)}</th>)}
                  <th className="px-4 py-3">Actions</th></tr>
              </thead>
              <tbody>
                {!rows.length&&<tr><td colSpan={MODULES[active].columns.length+1} className="p-8 text-center text-slate-500">No records yet. Create the first item to connect this module to CloudForge.</td></tr>}
                {rows.map(row=><tr key={String(row.id)} className="border-t border-slate-100 hover:bg-slate-50">
                  {MODULES[active].columns.map(x=><td key={x} className="px-4 py-3 whitespace-nowrap max-w-[220px] truncate">{active==="documents"&&x==="kind"?engineeringKindLabel(row[x]):display(row[x])}</td>)}
                  <td className="px-4 py-3 whitespace-nowrap">
                    {active==="documents"?<button onClick={()=>void inspectDocument(String(row.id))} className="text-teal-700 font-semibold hover:underline">Revisions <ChevronRight className="inline" size={13}/></button>:
                    active==="production"?<button onClick={()=>void inspectProduction(String(row.id))} className="text-teal-700 font-semibold hover:underline">Track job <ChevronRight className="inline" size={13}/></button>:
                    active==="service"?<button onClick={()=>void inspectService(String(row.id))} className="text-teal-700 font-semibold hover:underline">Service log <ChevronRight className="inline" size={13}/></button>:
                    editable&&transitions[active]?.[String(row.status)]?.length?<div className="flex gap-1">
                      {transitions[active]?.[String(row.status)].map(next=>
                        <button disabled={busy} key={next} onClick={()=>void changeStatus(active,String(row.id),next)}
                          className="border border-teal-200 text-teal-800 px-2 py-1 rounded text-[10px] hover:bg-teal-50">{titleize(next)}</button>)}
                    </div>:<span className="text-slate-300">—</span>}
                  </td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </Panel>

        {active==="documents"&&focusedDoc&&<Panel className="p-6 space-y-5">
          <div className="flex items-center justify-between"><div>
            <p className="text-xs uppercase tracking-widest text-teal-700 font-bold">Engineering control</p>
            <h2 className="text-lg font-bold">{display(selectedDocument?.title)} · revisions</h2></div>
            <button aria-label="Close revisions" onClick={()=>setFocusedDoc(null)} className="text-slate-500"><ArrowLeft size={18}/></button>
          </div>
          {editable&&<form onSubmit={event=>void upload(event)} className="border border-dashed border-teal-200 bg-teal-50/50 rounded-lg p-4 flex flex-wrap items-end gap-3">
            <label className="text-xs font-semibold flex-1 min-w-[200px]">Revision file (50 MB max)
              <input type="file" name="file" required className="block w-full mt-2 text-xs"/></label>
            <label className="text-xs font-semibold flex-1 min-w-[180px]">Change notes
              <input name="notes" placeholder="What changed?" className="block w-full mt-2 p-2 border rounded-md"/></label>
            <Button type="submit" disabled={busy}><UploadCloud size={14}/> Upload draft</Button>
          </form>}
          <div className="space-y-2">
            {!revisions.length&&<p className="text-xs text-slate-500">No file revisions uploaded yet.</p>}
            {revisions.map(r=><div key={r.id} className="border rounded-lg p-3 flex flex-wrap gap-3 items-center justify-between">
              <div><strong className="text-sm">{r.file_name}</strong><p className="text-[11px] text-slate-500 mt-1">
                Revision {r.revision} · {titleize(r.status)} · {(r.byte_size/1024).toFixed(1)} KB · SHA-256 {r.sha256.slice(0,12)}…</p></div>
              <div className="flex gap-2">
                {(user.role==="admin"||(r.status==="approved"&&user.role==="operator"))&&<a href={"/api/engineering/revisions/"+r.id}
                  className="inline-flex gap-2 items-center border border-slate-300 rounded-md px-3 py-2 text-xs font-semibold hover:bg-slate-50"><Download size={13}/> Download</a>}
                {r.status==="draft"&&user.role==="admin"&&<Button disabled={busy} onClick={()=>void approve(r.id)}><ShieldCheck size={14}/> Approve release</Button>}
              </div>
            </div>)}
          </div>
          <p className="text-xs text-slate-500">Only approved releases are available for field installation. The actual PLC/HMI transfer takes place in the vendor programming software under site authorization.</p>
        </Panel>}

        {active==="production"&&focusedJob&&<Panel className="p-6 space-y-4">
          <div className="flex justify-between items-center"><h2 className="text-lg font-bold">Production job · {display(selectedProduction?.job_code)}</h2>
            <button onClick={()=>setFocusedJob(null)} aria-label="Close production tracker"><ArrowLeft size={18}/></button></div>
          {editable&&<form onSubmit={event=>void addProductionEvent(event)} className="grid md:grid-cols-4 gap-3 bg-slate-50 rounded-lg p-4">
            <label className="text-xs font-semibold">Action<select value={productionAction} onChange={e=>setProductionAction(e.target.value)}
              className="mt-1 block w-full p-2 border rounded-md bg-white">
              {["start","hold","resume","progress","scrap","material","complete","note"].map(x=><option key={x} value={x}>{titleize(x)}</option>)}
            </select></label>
            {["progress","scrap","material"].includes(productionAction)&&<label className="text-xs font-semibold">Quantity
              <input type="number" name="quantity" min="0.001" step="0.001" required className="mt-1 block w-full p-2 border rounded-md"/></label>}
            {productionAction==="material"&&<>
              <label className="text-xs font-semibold">Inventory SKU<select required name="sku" defaultValue="" className="mt-1 block w-full p-2 border rounded-md">
                <option value="">Select SKU</option>{options.sku.map(x=><option key={x.value} value={x.value}>{x.label}</option>)}</select></label>
              <label className="text-xs font-semibold">Warehouse location<input required name="location" className="mt-1 block w-full p-2 border rounded-md"/></label>
              <label className="text-xs font-semibold">Bin<input required name="bin" className="mt-1 block w-full p-2 border rounded-md"/></label>
            </>}
            <label className="text-xs font-semibold md:col-span-2">Operator notes<input name="notes" className="mt-1 block w-full p-2 border rounded-md"/></label>
            <div className="flex items-end"><Button type="submit" disabled={busy}>Record event</Button></div>
          </form>}
          <h3 className="font-bold text-sm">Shop-floor event history</h3>
          {!events.length&&<p className="text-xs text-slate-500">No events yet.</p>}
          {events.map(e=><p key={e.id} className="border-b pb-2 text-xs">
            <b>{titleize(e.kind)}</b> {Number(e.quantity)>0?"· "+e.quantity+" "+(e.sku??"units"):""} — {e.actor_name} · {new Date(e.created_at).toLocaleString()}
            {e.notes?" · "+e.notes:""}</p>)}
        </Panel>}

        {active==="service"&&focusedService&&<Panel className="p-6 space-y-4">
          <div className="flex justify-between items-center"><div><h2 className="font-bold text-lg">Customer field service · {display(selectedService?.asset_tag)}</h2>
            <p className="text-xs text-slate-500">Only approved programs mapped to this equipment or project are available.</p></div>
            <button onClick={()=>setFocusedService(null)} aria-label="Close service log"><ArrowLeft size={18}/></button></div>
          {editable&&<form onSubmit={event=>void recordInstall(event)} className="grid md:grid-cols-3 gap-3 bg-slate-50 p-4 rounded-lg">
            <label className="text-xs font-semibold md:col-span-2">Approved PLC/HMI revision
              <select name="revisionId" required defaultValue="" className="mt-1 block w-full p-2 border rounded-md bg-white">
                <option value="">Choose approved revision</option>
                {matchingReleases.map(r=><option value={r.id} key={r.id}>{r.title} · rev {r.revision} · {r.file_name}</option>)}
              </select></label>
            <label className="text-xs font-semibold">Outcome<select name="result" className="mt-1 block w-full p-2 border rounded-md bg-white">
              {["installed","failed","rolled_back"].map(x=><option key={x} value={x}>{titleize(x)}</option>)}</select></label>
            <label className="text-xs font-semibold md:col-span-2">Service notes<input name="notes" placeholder="Controller, firmware, verification details" className="mt-1 block w-full p-2 border rounded-md"/></label>
            <div className="flex items-end"><Button type="submit" disabled={busy||!matchingReleases.length}>Record installation</Button></div>
          </form>}
          <div className="space-y-2">{matchingReleases.map(r=><div className="flex justify-between border rounded-lg p-3 text-xs" key={r.id}>
            <span><b>{titleize(r.kind)}</b> · {r.title} · rev {r.revision}</span>
            {(user.role==="admin"||user.role==="operator")&&<a className="text-teal-700 font-semibold flex items-center gap-1" href={"/api/engineering/revisions/"+r.id}><Download size={13}/> Download</a>}
          </div>)}</div>
          <h3 className="font-bold text-sm">Approved Electrical & Mechanical Schematics</h3>
          {!matchingSchematics.length&&<p className="text-xs text-slate-500">No approved schematics are associated with this service work.</p>}
          {matchingSchematics.map(r=><div key={r.id} className="flex flex-wrap justify-between gap-3 border rounded-lg p-3 text-xs">
            <span><b>{engineeringKindLabel(r.kind)}</b> · {r.title} · revision {r.revision}</span>
            <a href={"/api/engineering/revisions/"+r.id} className="text-teal-700 font-semibold flex gap-1 items-center"><Download size={13}/> Download Approved Drawing</a>
          </div>)}
          <h3 className="font-bold text-sm">Recorded field installations</h3>
          {!installs.length&&<p className="text-xs text-slate-500">No installed revisions recorded yet.</p>}
          {installs.map(i=><p className="text-xs border-b py-2" key={i.id}><b>{titleize(i.result)}</b> · {i.document_title} rev {i.revision} · {i.technician} · {new Date(i.performed_at).toLocaleString()} {i.notes?" · "+i.notes:""}</p>)}
        </Panel>}

        <p className="text-xs text-slate-500 flex items-start gap-2"><ShieldCheck size={14}/>
          Project data and engineering releases are access-controlled and audited within this installation. PLC/HMI programming and machine safety procedures remain customer/site controlled.
        </p>
      </div>
    </main>
  </div>;
}
