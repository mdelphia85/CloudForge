"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import OrganizationSwitcher from "@/components/organization-switcher";

type User={id:string;email:string;displayName:string;role:string;isActive:boolean};
type Invitation={id:string;email:string;role:string;createdAt:string;expiresAt:string;acceptedAt:string|null;revokedAt:string|null};

async function json<T>(url:string,init?:RequestInit):Promise<T> {
  const response=await fetch(url,{...init,credentials:"same-origin",cache:"no-store"});
  const data=await response.json() as T & {error?:string};
  if(!response.ok) throw new Error(data.error ?? "Unable to complete request.");
  return data;
}

export default function OrganizationMembersPage() {
  const [users,setUsers]=useState<User[]>([]);
  const [invitations,setInvitations]=useState<Invitation[]>([]);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [inviteLink,setInviteLink]=useState("");
  const [busy,setBusy]=useState(false);

  const refresh=useCallback(async()=>{
    const [u,i]=await Promise.all([
      json<{users:User[]}>("/api/users"),
      json<{invitations:Invitation[]}>("/api/organizations/invitations"),
    ]);
    setUsers(u.users);
    setInvitations(i.invitations);
  },[]);
  useEffect(()=>{void refresh().catch(e=>setError(e instanceof Error?e.message:"Unable to load members."));},[refresh]);

  async function invite(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=event.currentTarget;
    const data=new FormData(form);
    setBusy(true);setError("");setNotice("");setInviteLink("");
    try {
      const result=await json<{inviteLink:string}>("/api/organizations/invitations",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email:data.get("email"),role:data.get("role")}),
      });
      setInviteLink(result.inviteLink);
      form.reset();
      setNotice("Invitation issued. Share the unique link securely with the intended person; it will not be displayed again.");
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:"Invitation could not be issued.");}
    finally {setBusy(false);}
  }

  async function revoke(id:string) {
    setBusy(true);setError("");setNotice("");setInviteLink("");
    try {
      await json("/api/organizations/invitations/"+id,{
        method:"PATCH",headers:{"Content-Type":"application/json"},
      });
      setNotice("Invitation revoked. Its link can no longer be used.");
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:"Invitation could not be revoked.");}
    finally{setBusy(false);}
  }

  async function changeRole(userId:string,role:string) {
    setBusy(true);setError("");setNotice("");setInviteLink("");
    try {
      await json("/api/organizations/members/"+userId,{
        method:"PATCH",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({role}),
      });
      setNotice("Organization role updated. Sessions in this organization were revoked.");
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:"Unable to change member role.");}
    finally{setBusy(false);}
  }

  async function removeMember(userId:string,email:string) {
    if(!window.confirm("Remove "+email+" from this organization? Their other organizations will be unaffected."))return;
    setBusy(true);setError("");setNotice("");setInviteLink("");
    try {
      await json("/api/organizations/members/"+userId,{method:"DELETE"});
      setNotice("Member access was revoked for this organization.");
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:"Unable to remove member.");}
    finally{setBusy(false);}
  }

  return <main className="min-h-screen bg-slate-100 text-slate-800 p-4 md:p-8">
    <div className="max-w-5xl mx-auto space-y-5">
      <header className="rounded-xl bg-white border p-5 flex flex-wrap gap-4 justify-between items-center">
        <div><Link href="/" className="text-teal-800 text-xs font-semibold underline">Back to CloudForge</Link>
          <h1 className="text-2xl font-bold mt-1">Organization Members</h1>
          <p className="text-sm text-slate-600">Manage members and secure invitations for your active organization.</p>
        </div><OrganizationSwitcher/>
      </header>
      {error&&<p role="alert" className="rounded-lg bg-rose-50 border border-rose-200 p-3 text-sm text-rose-800">{error}</p>}
      {notice&&<p role="status" className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-800">{notice}</p>}
      <section className="rounded-xl bg-white border p-5 space-y-3">
        <h2 className="font-bold text-lg">Invite a Member</h2>
        <p className="text-sm text-slate-500">New invitations require an active license and an available licensed user seat.</p>
        <form onSubmit={event=>void invite(event)} className="grid gap-3 sm:grid-cols-[1fr_180px_auto] sm:items-end">
          <label className="text-sm font-semibold">Email address
            <input type="email" name="email" required maxLength={254}
              className="mt-1 block rounded-md border p-2 w-full"/>
          </label>
          <label className="text-sm font-semibold">Organization role
            <select name="role" defaultValue="viewer" className="mt-1 block rounded-md border p-2 w-full">
              <option value="viewer">Viewer</option>
              <option value="operator">Operator</option>
              <option value="admin">Administrator</option>
            </select>
          </label>
          <button disabled={busy} type="submit" className="bg-teal-800 text-white rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-40">
            Issue Invitation
          </button>
        </form>
        {inviteLink&&<div className="rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-semibold">One-time invitation link — only available now</p>
          <input readOnly value={inviteLink} aria-label="One-time invitation link"
            className="mt-2 p-2 rounded border w-full text-xs bg-white" onFocus={event=>event.currentTarget.select()}/>
          <p className="mt-2 text-xs">Copy and share directly with the invited person through a secure channel.</p>
        </div>}
      </section>
      <section className="rounded-xl bg-white border p-5 overflow-x-auto">
        <h2 className="font-bold text-lg mb-3">Current Members ({users.length})</h2>
        <table className="w-full text-sm"><thead><tr className="text-left border-b">
          <th className="p-2">Name</th><th className="p-2">Email</th><th className="p-2">Role</th><th className="p-2">Account</th><th className="p-2">Actions</th>
        </tr></thead><tbody>{users.map(user=><tr key={user.id} className="border-b">
          <td className="p-2">{user.displayName}</td><td className="p-2">{user.email}</td>
          <td className="p-2">
            <select aria-label={"Role for "+user.email} value={user.role} disabled={busy}
              onChange={event=>void changeRole(user.id,event.target.value)}
              className="border rounded-md p-2 bg-white">
              <option value="viewer">Viewer</option>
              <option value="operator">Operator</option>
              <option value="admin">Administrator</option>
            </select>
          </td>
          <td className="p-2">{user.isActive?"Active":"Disabled"}</td>
          <td className="p-2">
            <button type="button" disabled={busy} className="text-rose-700 underline font-semibold disabled:opacity-40"
              onClick={()=>void removeMember(user.id,user.email)}>Remove access</button>
          </td>
        </tr>)}</tbody></table>
      </section>
      <section className="rounded-xl bg-white border p-5 overflow-x-auto">
        <h2 className="font-bold text-lg mb-3">Invitations ({invitations.length})</h2>
        <table className="w-full text-sm"><thead><tr className="text-left border-b">
          <th className="p-2">Email</th><th className="p-2">Role</th><th className="p-2">Status</th><th className="p-2">Expires</th><th className="p-2">Action</th>
        </tr></thead><tbody>{invitations.map(invite=>{
          const status=invite.acceptedAt?"Accepted":invite.revokedAt?"Revoked":
            new Date(invite.expiresAt).getTime()<=Date.now()?"Expired":"Pending";
          return <tr key={invite.id} className="border-b"><td className="p-2">{invite.email}</td>
            <td className="p-2">{invite.role}</td><td className="p-2">{status}</td>
            <td className="p-2 whitespace-nowrap">{new Date(invite.expiresAt).toLocaleDateString()}</td>
            <td className="p-2">{status==="Pending"&&<button type="button" disabled={busy}
              className="text-rose-700 font-semibold underline disabled:opacity-50"
              onClick={()=>void revoke(invite.id)}>Revoke</button>}</td>
          </tr>;
        })}</tbody></table>
      </section>
    </div>
  </main>;
}
