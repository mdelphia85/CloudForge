import { describe, expect, it } from "vitest";
import { formatDisplayLabel } from "@/lib/display-label";

describe("display labels", () => {
  it.each([
    ["plc", "PLC"], ["hmi", "HMI"], ["bom", "BOM"], ["sop", "SOP"],
    ["sku", "SKU"], ["scada", "SCADA"], ["erp", "ERP"], ["opc_ua", "OPC UA"],
    ["api", "API"], ["sql", "SQL"], ["pm", "PM"], ["mtbf", "MTBF"],
    ["mttr", "MTTR"], ["id", "ID"], ["iot", "IoT"],
  ])("formats %s as %s", (value, label) => {
    expect(formatDisplayLabel(value)).toBe(label);
  });

  it("formats headings, punctuation, and normal words without partial acronym matches", () => {
    expect(formatDisplayLabel("Create Drawing & PLC/HMI library record"))
      .toBe("Create Drawing & PLC/HMI Library Record");
    expect(formatDisplayLabel("plc_make")).toBe("PLC Make");
    expect(formatDisplayLabel("bomRevision")).toBe("BOM Revision");
    expect(formatDisplayLabel("equipment_id")).toBe("Equipment ID");
    expect(formatDisplayLabel("drawing specification manual other")).toBe("Drawing Specification Manual Other");
    expect(formatDisplayLabel("rapid identity")).toBe("Rapid Identity");
    expect(formatDisplayLabel("fix it")).toBe("Fix It");
    expect(formatDisplayLabel("constructor")).toBe("Constructor");
  });

  it("does not alter stored option values", () => {
    const values = ["drawing", "bom", "sop", "plc", "hmi"];
    const options = values.map((value) => ({ value, label: formatDisplayLabel(value) }));
    expect(options).toEqual([
      { value: "drawing", label: "Drawing" },
      { value: "bom", label: "BOM" },
      { value: "sop", label: "SOP" },
      { value: "plc", label: "PLC" },
      { value: "hmi", label: "HMI" },
    ]);
  });
});
