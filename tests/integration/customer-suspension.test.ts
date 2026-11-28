import { afterAll, beforeAll, expect, it } from "vitest";
import { call, closeDatabases, loadHandlers, resetDatabase, seedActors, testPool, type Actors } from "./harness";
import * as status from "@/app/api/platform/organizations/[id]/route";

let actors:Actors;
let orgA="";
let orgB="";

const patch=(id:string,action:"suspend"|"reactivate",cookie:string)=>
  call(request=>status.PATCH(request,{params:Promise.resolve({id})}),{
    method:"PATCH",cookie,body:{action},
  });

beforeAll(async()=>{
  await resetDatabase();
  actors=await seedActors(await loadHandlers());
  orgA=(await testPool().query<{id:string}>(
    "SELECT id FROM organizations WHERE identifier='existing-installation'",
  )).rows[0].id;
  await testPool().query("INSERT INTO platform_owners(user_id) VALUES($1)",[actors.admin.id]);
  // Isolated disposable test DB only.
  await testPool().query("DROP INDEX organizations_single_installation_only");
  orgB=(await testPool().query<{id:string}>(
    "INSERT INTO organizations(identifier,name,deployment_type) " +
      "VALUES('test-other-customer','Other Customer','saas') RETURNING id",
  )).rows[0].id;
});
afterAll(closeDatabases);

it("requires platform-owner authorization to suspend customer organization",async()=>{
  const forbidden=await patch(orgB,"suspend",actors.operator.cookie);
  expect(forbidden.status).toBe(403);
  const row=await testPool().query("SELECT status FROM organizations WHERE id=$1",[orgB]);
  expect(row.rows[0].status).toBe("active");
});

it("does not permit suspension of the platform recovery organization",async()=>{
  const refused=await patch(orgA,"suspend",actors.admin.cookie);
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe("PLATFORM_RECOVERY_ORGANIZATION");
});

it("suspends and reactivates only the selected customer while preserving audit events",async()=>{
  const suspended=await patch(orgB,"suspend",actors.admin.cookie);
  expect(suspended.status).toBe(200);
  expect(suspended.body.organization).toMatchObject({id:orgB,status:"suspended",changed:true});
  const original=await testPool().query("SELECT status FROM organizations WHERE id=$1",[orgA]);
  expect(original.rows[0].status).toBe("active");

  const repeated=await patch(orgB,"suspend",actors.admin.cookie);
  expect(repeated.status).toBe(200);
  expect(repeated.body.organization.changed).toBe(false);

  const reactivated=await patch(orgB,"reactivate",actors.admin.cookie);
  expect(reactivated.status).toBe(200);
  expect(reactivated.body.organization.status).toBe("active");
  const events=await testPool().query<{action:string}>(
    "SELECT action FROM audit_events WHERE entity_id=$1 ORDER BY created_at",
    [orgB],
  );
  expect(events.rows.map(row=>row.action)).toEqual([
    "platform.organization_suspended","platform.organization_reactivated",
  ]);
});
