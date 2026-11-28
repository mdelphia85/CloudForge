const ACRONYMS = new Map(Object.entries({
  api: "API",
  bom: "BOM",
  cad: "CAD",
  cnc: "CNC",
  erp: "ERP",
  eta: "ETA",
  hmi: "HMI",
  id: "ID",
  iot: "IoT",
  ip: "IP",
  kb: "KB",
  mb: "MB",
  mes: "MES",
  mtbf: "MTBF",
  mttr: "MTTR",
  opc: "OPC",
  ot: "OT",
  plc: "PLC",
  pm: "PM",
  po: "PO",
  scada: "SCADA",
  sku: "SKU",
  sop: "SOP",
  sql: "SQL",
  tcp: "TCP",
  ua: "UA",
  ui: "UI",
  url: "URL",
}));

export function formatDisplayLabel(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ")
    .replace(/\b[a-zA-Z0-9]+\b/g, (word) =>
      ACRONYMS.get(word.toLowerCase()) ?? word.charAt(0).toUpperCase() + word.slice(1),
    );
}
