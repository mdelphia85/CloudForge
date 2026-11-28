"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

type Organization = { id: string; name: string; identifier: string; status: string };
type License = {
  claims: { licenseId: string; licenseType: string; tier: string; seatLimit: number; modules: string[]; expiresAt: string };
  timeStatus: string;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store" });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "The request could not be completed.");
  return result;
}

export default function PlatformLicensing() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selected, setSelected] = useState("");
  const [license, setLicense] = useState<License | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [newInviteLink,setNewInviteLink] = useState("");
  const selectionVersion = useRef(0);

  useEffect(() => {
    let active = true;
    request<{ organizations: Organization[] }>("/api/platform/organizations")
      .then((result) => { if (active) setOrganizations(result.organizations); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load organizations."); });
    return () => { active = false; };
  }, []);

  async function loadLicense(organizationId: string) {
    const version = ++selectionVersion.current;
    setSelected(organizationId);
    setLicense(null);
    setError("");
    setNotice("");
    if (!organizationId) return;
    try {
      const result = await request<{ license: License | null }>(`/api/platform/licenses?organizationId=${encodeURIComponent(organizationId)}`);
      if (version === selectionVersion.current) setLicense(result.license);
    } catch (reason) {
      if (version === selectionVersion.current) setError(reason instanceof Error ? reason.message : "Unable to load the license.");
    }
  }

  async function install(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    ++selectionVersion.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const file = new FormData(form).get("license");
      if (!(file instanceof File) || file.size === 0 || file.size > 24_000) throw new Error("Choose a signed license file of at most 24 KB.");
      const envelope: unknown = JSON.parse(await file.text());
      if (!envelope || typeof envelope !== "object" || !("payload" in envelope) || !("signature" in envelope)) {
        throw new Error("The license file must contain a payload and signature.");
      }
      const result = await request<{ license: License }>("/api/platform/licenses", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: selected, payload: envelope.payload, signature: envelope.signature }),
      });
      setLicense(result.license);
      setNotice("Signed license verified and stored.");
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to install the license.");
    } finally {
      setBusy(false);
    }
  }

  async function changeOrganizationStatus(action:"suspend"|"reactivate") {
    if (!selected) return;
    const organization=organizations.find(item=>item.id===selected);
    if (!organization) return;
    setBusy(true);setError("");setNotice("");
    try {
      const updated=await request<{organization:{id:string;status:string}}>(
        "/api/platform/organizations/"+encodeURIComponent(selected),{
          method:"PATCH",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({action}),
        },
      );
      setOrganizations(existing=>existing.map(item=>item.id===selected
        ? {...item,status:updated.organization.status} : item));
      setNotice("Organization status changed to "+updated.organization.status+
        ". Licensed modules remain subject to server-side access checks.");
    }catch(reason){setError(reason instanceof Error?reason.message:"Organization status could not be changed.");}
    finally{setBusy(false);}
  }

  async function createOrganization(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=event.currentTarget;
    const data=new FormData(form);
    setBusy(true);setError("");setNotice("");setNewInviteLink("");
    try {
      const result=await request<{organization:Organization}>("/api/platform/organizations",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          identifier:data.get("identifier"),
          name:data.get("name"),
          deploymentType:data.get("deploymentType"),
        }),
      });
      const fresh=await request<{organizations:Organization[]}>("/api/platform/organizations");
      setOrganizations(fresh.organizations);
      await loadLicense(result.organization.id);
      setNotice("Organization created. Issue and install its individual signed license, then invite its first administrator.");
      form.reset();
    }catch(reason){setError(reason instanceof Error?reason.message:"Could not create organization.");}
    finally{setBusy(false);}
  }

  async function inviteFirstAdministrator(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=event.currentTarget;
    const data=new FormData(form);
    setBusy(true);setError("");setNotice("");setNewInviteLink("");
    try {
      const invited=await request<{inviteLink:string}>("/api/platform/invitations",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          organizationId:selected,email:data.get("email"),role:"admin",
        }),
      });
      setNewInviteLink(invited.inviteLink);
      setNotice("Invitation created. Share the one-time link directly with the customer administrator.");
      form.reset();
    }catch(reason){setError(reason instanceof Error?reason.message:"Could not issue invitation.");}
    finally{setBusy(false);}
  }

  return <main className="min-h-screen bg-slate-100 p-6 text-slate-800">
    <div className="mx-auto max-w-3xl space-y-4 rounded-xl border bg-white p-6">
      <Link href="/" className="text-sm text-teal-700 underline">Back to CloudForge</Link>
      <h1 className="text-2xl font-bold">Platform license administration</h1>
      <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
        Commercial activation remains gated until all tenant isolation, access-control, billing, and recovery requirements pass verification. Do not onboard paying customers yet.
      </p>
      {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
      <section className="rounded-lg border p-4 space-y-3">
        <h2 className="font-bold text-lg">Register a Customer Organization</h2>
        <p className="text-xs text-slate-600">Only a platform owner can create organizations. Shared SaaS creation remains blocked until the commercial activation gate is approved.</p>
        <form onSubmit={event=>void createOrganization(event)} className="grid gap-3 md:grid-cols-2">
          <label className="text-sm font-semibold">Unique organization identifier
            <input name="identifier" required pattern="[a-z0-9][a-z0-9-]{2,62}"
              placeholder="customer-company" className="mt-1 block w-full rounded border p-2 text-sm"/>
          </label>
          <label className="text-sm font-semibold">Company name
            <input name="name" required minLength={2} maxLength={160}
              className="mt-1 block w-full rounded border p-2 text-sm"/>
          </label>
          <label className="text-sm font-semibold">Deployment type
            <select name="deploymentType" defaultValue="saas" className="mt-1 block w-full rounded border p-2 text-sm">
              <option value="saas">Shared Cloud SaaS</option>
              <option value="dedicated">Dedicated Cloud</option>
              <option value="on_premises">On-Premises</option>
              <option value="air_gapped">Air-Gapped</option>
            </select>
          </label>
          <button type="submit" disabled={busy}
            className="self-end rounded bg-teal-700 px-4 py-2 text-white text-sm font-semibold disabled:opacity-40">
            Register Organization
          </button>
        </form>
      </section>
      <label className="block text-sm font-semibold">Organization
        <select value={selected} disabled={busy} onChange={(event) => void loadLicense(event.target.value)} className="mt-1 block w-full rounded border p-2">
          <option value="">Select an organization</option>
          {organizations.map((organization) => <option value={organization.id} key={organization.id}>
            {organization.name} ({organization.identifier}) · {organization.status}
          </option>)}
        </select>
      </label>
      {selected && <>
        <section className="rounded border p-4 text-sm space-y-3">
          <h2 className="font-bold">Customer Organization Status</h2>
          <p>Status: <strong>{organizations.find(org=>org.id===selected)?.status ?? "Unknown"}</strong></p>
          <p className="text-xs text-slate-600">
            Suspending an organization blocks its users from operational access without affecting other customers.
            The original platform recovery organization cannot be suspended.
          </p>
          {organizations.find(org=>org.id===selected)?.status==="active"
            ? <button type="button" disabled={busy} onClick={()=>void changeOrganizationStatus("suspend")}
                className="rounded-md border border-rose-300 text-rose-700 font-semibold px-3 py-2 disabled:opacity-40">
                Suspend Organization
              </button>
            : <button type="button" disabled={busy} onClick={()=>void changeOrganizationStatus("reactivate")}
                className="rounded-md bg-teal-700 text-white font-semibold px-3 py-2 disabled:opacity-40">
                Reactivate Organization
              </button>}
        </section>
        <section className="rounded border p-4 text-sm">
          <h2 className="font-bold">Installed license</h2>
          {license ? <div className="mt-2 space-y-1">
            <p>ID: {license.claims.licenseId}</p><p>Status: {license.timeStatus}</p>
            <p>Type: {license.claims.licenseType} · Tier: {license.claims.tier}</p>
            <p>Seats: {license.claims.seatLimit} · Expires: {license.claims.expiresAt}</p>
            <p>Modules: {license.claims.modules.join(", ")}</p>
          </div> : <p className="mt-2">No verified license displayed.</p>}
        </section>
        <form onSubmit={(event) => void install(event)} className="space-y-3">
          <label className="block text-sm font-semibold">Signed license file
            <input name="license" type="file" accept=".json,application/json" required className="mt-1 block w-full text-sm"/>
          </label>
          <p className="text-xs text-slate-600">Import only the signed license file. Never upload a private signing key.</p>
          <button disabled={busy} className="rounded bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Verify and install</button>
        </form>
        <section className="mt-5 border-t pt-4 space-y-3">
          <h2 className="font-bold">Invite the First Organization Administrator</h2>
          <p className="text-xs text-slate-600">Install an active, individually signed license before inviting a customer&apos;s first admin. You will not automatically gain access to their data.</p>
          <form onSubmit={event=>void inviteFirstAdministrator(event)} className="flex flex-wrap gap-3 items-end">
            <label className="text-sm font-semibold flex-1 min-w-[180px]">Administrator email
              <input name="email" type="email" maxLength={254} required
                className="mt-1 block w-full rounded border p-2 text-sm"/>
            </label>
            <button type="submit" disabled={busy}
              className="rounded bg-teal-700 px-4 py-2 text-sm text-white font-semibold disabled:opacity-40">
              Issue Admin Invitation
            </button>
          </form>
          {newInviteLink&&<div className="border border-amber-300 bg-amber-50 rounded p-3">
            <p className="text-xs font-bold">One-time invitation link. Share securely with the intended customer.</p>
            <input value={newInviteLink} readOnly className="mt-2 w-full border rounded p-2 text-xs bg-white"
              onFocus={event=>event.currentTarget.select()}/>
          </div>}
        </section>
      </>}
    </div>
  </main>;
}
