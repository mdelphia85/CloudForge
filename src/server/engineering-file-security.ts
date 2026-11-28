import "server-only";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { once } from "node:events";
import { HttpError } from "@/server/errors";

export const MAX_ENGINEERING_FILE_BYTES=50*1024*1024;
const EXECUTABLE=/\.(exe|dll|com|msi|bat|cmd|ps1|vbs|js|mjs|cjs|html?|svg|sh)$/i;

export function validateEngineeringFileName(raw:string):string {
  const name=raw.split(/[\\/]/).pop() ?? "";
  if(name.length<1||name.length>180||/[\x00-\x1f\x7f]/.test(name)||
     name==="."||name==="..") {
    throw new HttpError(400,"INVALID_NAME","The engineering file name is invalid.");
  }
  if(EXECUTABLE.test(name)) {
    throw new HttpError(415,"UNSUPPORTED_FILE",
      "Executable and active-content files cannot be uploaded as engineering programs or schematics.");
  }
  return name;
}

export function validateEngineeringFileIntegrity(
  bytes:Uint8Array,expectedHash:string,expectedLength:number,
):void {
  if(bytes.length!==Number(expectedLength)||
     createHash("sha256").update(bytes).digest("hex")!==expectedHash.toLowerCase()) {
    throw new HttpError(503,"ENGINEERING_FILE_INTEGRITY",
      "Engineering file checksum verification failed. Do not use this revision.");
  }
}

export function engineeringMalwareScanRequired():boolean {
  return process.env.CLOUDFORGE_MULTI_ORGANIZATION_ENABLED==="true" ||
    process.env.CLOUDFORGE_LICENSE_ENFORCEMENT_REQUIRED==="true" ||
    process.env.CLOUDFORGE_ENGINEERING_MALWARE_SCAN_REQUIRED==="true";
}

/**
 * Scan original opaque file bytes through the customer-controlled ClamAV clamd
 * INSTREAM protocol. Nothing is sent to any third-party scanning service.
 * Scanner must be on a protected internal network. No file execution/extraction
 * occurs within CloudForge, and the bytes are never modified.
 */
export async function scanEngineeringFile(bytes:Uint8Array):Promise<void> {
  if(!engineeringMalwareScanRequired())return;
  const host=process.env.CLOUDFORGE_CLAMAV_HOST ?? "";
  const port=Number(process.env.CLOUDFORGE_CLAMAV_PORT ?? "3310");
  if(!/^[A-Za-z0-9][A-Za-z0-9.\-_]{0,252}$/.test(host) ||
     !Number.isInteger(port)||port<1||port>65535) {
    throw new HttpError(503,"ENGINEERING_SCANNER_UNAVAILABLE",
      "An internal engineering-file malware scanner must be configured for commercial deployments.");
  }
  if(bytes.length===0||bytes.length>MAX_ENGINEERING_FILE_BYTES) {
    throw new HttpError(413,"FILE_TOO_LARGE","Engineering files must be between 1 byte and 50 MB.");
  }
  const result=await new Promise<string>((resolve,reject)=>{
    const socket=createConnection({host,port});
    socket.setTimeout(30_000);
    let complete=false;
    let output="";
    const terminate=(error?:Error,response?:string)=>{
      if(complete)return;
      complete=true;
      socket.destroy();
      if(error)reject(error);
      else resolve(response ?? "");
    };
    socket.on("timeout",()=>terminate(new Error("ClamAV scan timed out")));
    socket.on("error",error=>terminate(error));
    socket.on("close",()=>{
      if(!complete)terminate(new Error("ClamAV closed the scan without a result"));
    });
    socket.on("data",chunk=>{
      output+=chunk.toString("utf8");
      if(output.length>2048) {
        terminate(new Error("Invalid ClamAV scan response"));
        return;
      }
      if(output.includes("\0") || output.endsWith("\n")) {
        terminate(undefined,output);
      }
    });
    socket.on("connect",()=>{
      void (async()=>{
        try {
          const write=async(buffer:Buffer)=>{
            if(!socket.write(buffer))await once(socket,"drain");
          };
          await write(Buffer.from("zINSTREAM\0","utf8"));
          const chunkSize=64*1024;
          for(let i=0;i<bytes.length;i+=chunkSize) {
            if(complete)return;
            const chunk=Buffer.from(bytes.subarray(i,Math.min(i+chunkSize,bytes.length)));
            const header=Buffer.alloc(4);
            header.writeUInt32BE(chunk.length);
            await write(header);
            await write(chunk);
          }
          await write(Buffer.alloc(4)); // terminating zero-sized frame
        }catch(error){
          terminate(error instanceof Error?error:new Error("ClamAV scan interrupted"));
        }
      })();
    });
  }).catch(()=>{
    throw new HttpError(503,"ENGINEERING_SCANNER_UNAVAILABLE",
      "Engineering-file scanning did not complete. The file has not been accepted.");
  });
  if(/FOUND/i.test(result)) {
    throw new HttpError(415,"ENGINEERING_FILE_REJECTED",
      "The engineering file was rejected by the malware scanner.");
  }
  if(!/^stream: OK[\r\n\0]*$/i.test(result)) {
    throw new HttpError(503,"ENGINEERING_SCANNER_UNAVAILABLE",
      "The scanner did not return a verified clean result.");
  }
}

/** Lightweight fail-closed ClamAV availability check for commercial readiness. */
export async function engineeringScannerReady():Promise<boolean> {
  if(!engineeringMalwareScanRequired())return true;
  const host=process.env.CLOUDFORGE_CLAMAV_HOST ?? "";
  const port=Number(process.env.CLOUDFORGE_CLAMAV_PORT ?? "3310");
  if(!/^[A-Za-z0-9][A-Za-z0-9.\-_]{0,252}$/.test(host) ||
     !Number.isInteger(port)||port<1||port>65535) return false;
  return new Promise<boolean>(resolve=>{
    const socket=createConnection({host,port});
    let finished=false,output="";
    const done=(value:boolean)=>{
      if(finished)return;
      finished=true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2_000);
    socket.on("connect",()=>socket.write(Buffer.from("zPING\0")));
    socket.on("data",chunk=>{
      output+=chunk.toString("utf8");
      if(output.length>64)done(false);
      else if(output.includes("\0")||output.endsWith("\n")) {
        done(/^PONG[\r\n\0]*$/.test(output));
      }
    });
    socket.on("timeout",()=>done(false));
    socket.on("error",()=>done(false));
    socket.on("close",()=>done(false));
  });
}
