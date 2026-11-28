"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

export default function AcceptOrganizationInvitation() {
  const [token,setToken]=useState("");
  const [submitted,setSubmitted]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

  useEffect(()=>{
    let active=true;
    const hash=window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    window.history.replaceState(null,"","/join");
    // Read the URL fragment asynchronously, after mount; it never reaches the server.
    void Promise.resolve().then(()=>{
      const invite=new URLSearchParams(hash).get("token") ?? "";
      if (active && /^[A-Za-z0-9_-]{43}$/.test(invite)) setToken(invite);
    });
    return ()=>{active=false;};
  },[]);

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=event.currentTarget;
    const data=new FormData(form);
    setError("");
    setBusy(true);
    try {
      const response=await fetch("/api/organization-invitations/accept",{
        method:"POST",credentials:"same-origin",cache:"no-store",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          token,password:data.get("password"),displayName:data.get("displayName"),
        }),
      });
      const result=await response.json() as {error?:string};
      if(!response.ok) throw new Error(result.error ?? "Could not accept invitation.");
      form.reset();
      setToken("");
      setSubmitted(true);
    } catch(cause) {
      setError(cause instanceof Error?cause.message:"Could not accept invitation.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="min-h-screen bg-slate-100 px-4 py-14 text-slate-900">
    <div className="mx-auto max-w-lg rounded-xl border bg-white p-7 space-y-5 shadow-sm">
      <h1 className="text-2xl font-bold">Join a CloudForge Organization</h1>
      {submitted ? <div role="status" className="space-y-3 text-sm">
        <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3">
          Invitation accepted. Your organization membership is active.
        </p>
        <p>Sign in with your email and password. You can select your organization after login.</p>
        <Link href="/" className="text-teal-700 font-semibold underline">Return to sign in</Link>
      </div> : <>
        <p className="text-sm text-slate-600">
          An invitation is required. New users provide their display name
          and a strong password. Existing CloudForge users enter their current
          account password; the display name is ignored for existing accounts.
        </p>
        {!token && <p role="alert" className="text-sm rounded-md bg-amber-50 border border-amber-300 p-3">
          The invitation token is missing. Open the complete invitation link supplied by your organization.
        </p>}
        {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
        <form onSubmit={event=>void submit(event)} className="space-y-4">
          <label className="block text-sm font-semibold">Display name (new accounts)
            <input name="displayName" maxLength={120} autoComplete="name"
              className="mt-1 block w-full rounded-md border border-slate-300 p-3"/>
          </label>
          <label className="block text-sm font-semibold">Account password
            <input name="password" type="password" required maxLength={256} autoComplete="new-password"
              className="mt-1 block w-full rounded-md border border-slate-300 p-3"/>
          </label>
          <p className="text-xs text-slate-500">New passwords require 14+ characters, uppercase and lowercase letters, a number, and a symbol.</p>
          <button type="submit" disabled={!token||busy}
            className="rounded-md bg-teal-800 px-5 py-3 text-sm font-semibold text-white disabled:opacity-40">
            {busy?"Verifying invitation…":"Accept Invitation"}
          </button>
        </form>
      </>}
    </div>
  </main>;
}
