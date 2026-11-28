"use client";

import { useEffect, useState } from "react";

type Membership = { id: string; identifier: string; name: string; role: "admin" | "operator" | "viewer" };

export default function OrganizationSwitcher() {
  const [organizations, setOrganizations] = useState<Membership[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/organization", { credentials: "same-origin", cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Could not load organizations.");
        return response.json() as Promise<{
          selectedOrganizationId: string; organizations: Membership[];
        }>;
      })
      .then(data => {
        if (!active) return;
        setOrganizations(data.organizations);
        setSelected(data.selectedOrganizationId);
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Unable to load organizations."); });
    return () => { active = false; };
  }, []);

  async function switchTo(organizationId: string) {
    if (!organizationId || organizationId === selected) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/organization", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? "Organization switch was rejected.");
      }
      // Clear workspace-local state and reload all modules under the new membership.
      window.location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to switch organizations.");
    } finally {
      setBusy(false);
    }
  }

  if (!organizations.length) return error
    ? <span role="alert" className="text-xs text-rose-700">{error}</span>
    : null;

  return <div className="text-xs space-y-1">
    <label className="font-semibold block" htmlFor="cloudforge-active-organization">Active Organization</label>
    <select id="cloudforge-active-organization" disabled={busy || organizations.length < 2}
      value={selected} onChange={event => void switchTo(event.target.value)}
      className="rounded-md border border-slate-300 px-2 py-2 bg-white text-slate-800 w-full max-w-72">
      {organizations.map(organization =>
        <option key={organization.id} value={organization.id}>
          {organization.name} — {organization.role}
        </option>)}
    </select>
    {error && <p role="alert" className="text-rose-700">{error}</p>}
  </div>;
}
