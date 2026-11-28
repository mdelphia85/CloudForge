import {createHash} from "node:crypto";
import {afterAll,beforeAll,expect,it} from "vitest";
import {
  engineeringScannerReady,scanEngineeringFile,
  validateEngineeringFileIntegrity,validateEngineeringFileName,
} from "@/server/engineering-file-security";

const oldRequired=process.env.CLOUDFORGE_ENGINEERING_MALWARE_SCAN_REQUIRED;
const oldHost=process.env.CLOUDFORGE_CLAMAV_HOST;
const oldPort=process.env.CLOUDFORGE_CLAMAV_PORT;
const oldMulti=process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED;
const oldLicense=process.env.CLOUDFORGE_LICENSE_ENFORCEMENT_REQUIRED;

beforeAll(()=>{
  process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED="false";
  process.env.CLOUDFORGE_LICENSE_ENFORCEMENT_REQUIRED="false";
  process.env.CLOUDFORGE_ENGINEERING_MALWARE_SCAN_REQUIRED="false";
});
afterAll(()=>{
  const original:[string,string|undefined][]=[
    ["CLOUDFORGE_ENGINEERING_MALWARE_SCAN_REQUIRED",oldRequired],
    ["CLOUDFORGE_CLAMAV_HOST",oldHost],
    ["CLOUDFORGE_CLAMAV_PORT",oldPort],
    ["CLOUDFORGE_MULTI_ORGANIZATION_ENABLED",oldMulti],
    ["CLOUDFORGE_LICENSE_ENFORCEMENT_REQUIRED",oldLicense],
  ];
  for(const [name,value] of original) {
    if(value===undefined) delete process.env[name];
    else process.env[name]=value;
  }
});

it("preserves safe industrial formats and refuses active-content filenames",()=>{
  for(const filename of [
    "controller.ACD","sanding-station.l5x","operator_HMI.mer",
    "panel.eds","drawing.dwg","mechanical.step","mechanical.sldprt",
    "screen.ap16","logic.CX-P","program.zip",
  ])expect(validateEngineeringFileName(filename)).toBe(filename);
  for(const filename of ["payload.exe","remote.ps1","active.html","controller.js","diagram.svg"]) {
    expect(()=>validateEngineeringFileName(filename)).toThrow();
  }
  expect(validateEngineeringFileName("C:\\drawings\\panel.dwg")).toBe("panel.dwg");
  expect(()=>validateEngineeringFileName("..")).toThrow();
});

it("verifies original engineering bytes and exact byte count before download",()=>{
  const bytes=Buffer.from([0,1,255,100,42,9,0]);
  const hash=createHash("sha256").update(bytes).digest("hex");
  expect(()=>validateEngineeringFileIntegrity(bytes,hash,bytes.length)).not.toThrow();
  expect(()=>validateEngineeringFileIntegrity(bytes,hash,bytes.length+1)).toThrow();
  expect(()=>validateEngineeringFileIntegrity(bytes,"f".repeat(64),bytes.length)).toThrow();
});

it("fails closed for a commercial file when the internal scanner is absent",async()=>{
  process.env.CLOUDFORGE_ENGINEERING_MALWARE_SCAN_REQUIRED="true";
  delete process.env.CLOUDFORGE_CLAMAV_HOST;
  expect(await engineeringScannerReady()).toBe(false);
  await expect(scanEngineeringFile(Buffer.from("opaque program"))).rejects.toMatchObject({
    status:503,code:"ENGINEERING_SCANNER_UNAVAILABLE",
  });
});
