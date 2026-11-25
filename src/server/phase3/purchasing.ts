import "server-only";
import type { AuthenticatedUser } from "@/server/auth";
import { getPool, inTransaction } from "@/server/db";
import { HttpError } from "@/server/errors";
import { audit, nonNegativeMoney, optionalDate, optionalText, positive, requireProject, requireUuid, shortText } from "./shared";

type PurchaseLineInput = { sku: string; quantity: string; unitPrice: string; projectId: string | null };

function parseLines(value: unknown): PurchaseLineInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new HttpError(400, "INVALID_LINES", "A purchase order must contain 1 to 100 lines.");
  }
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new HttpError(400, "INVALID_LINE", "Each purchase order line must be an object.");
    }
    const line = entry as Record<string, unknown>;
    const sku = shortText(line.sku, "sku", 64).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku)) {
      throw new HttpError(400, "INVALID_SKU", "Provide a valid inventory SKU.");
    }
    return {
      sku,
      quantity: positive(line.quantity, "quantity"),
      unitPrice: nonNegativeMoney(line.unitPrice ?? 0, "unitPrice"),
      projectId: line.projectId ? requireUuid(line.projectId, "projectId") : null,
    };
  });
}

export async function listSuppliers() {
  const result = await getPool().query(
    "SELECT id,code,name,contact_name AS \"contactName\",email,phone,lead_time_days AS \"leadTimeDays\",is_active AS \"isActive\" " +
      "FROM suppliers ORDER BY is_active DESC,name",
  );
  return result.rows;
}

export async function createSupplier(body: Record<string, unknown>, user: AuthenticatedUser) {
  const code = shortText(body.code, "code", 40).toUpperCase();
  const name = shortText(body.name, "name", 200);
  const contact = optionalText(body.contactName, "contactName", 160);
  const email = optionalText(body.email, "email", 254);
  const phone = optionalText(body.phone, "phone", 40);
  const leadTime = body.leadTimeDays === undefined ? 0 : Number(body.leadTimeDays);
  if (!/^[A-Z0-9][A-Z0-9._-]{1,39}$/.test(code) || !Number.isInteger(leadTime) || leadTime < 0 || leadTime > 3650) {
    throw new HttpError(400, "INVALID_SUPPLIER", "Supplier code or lead time is invalid.");
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "INVALID_EMAIL", "Provide a valid supplier email address.");
  }
  return inTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      "INSERT INTO suppliers(code,name,contact_name,email,phone,lead_time_days,created_by) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [code, name, contact, email, phone, leadTime, user.id],
    );
    await audit(client, user, "supplier.created", "supplier", result.rows[0].id, { code, name });
    return { id: result.rows[0].id };
  });
}

export async function listPurchaseOrders() {
  const result = await getPool().query(
    "SELECT po.id,po.po_number AS \"poNumber\",po.status,po.order_date AS \"orderDate\", " +
      "po.expected_delivery AS \"expectedDelivery\",po.notes,s.name AS \"supplierName\",p.code AS \"projectCode\", " +
      "COALESCE(jsonb_agg(jsonb_build_object('id',l.id,'sku',i.sku,'itemName',i.name,'orderedQty',l.ordered_qty::text, " +
      "'receivedQty',l.received_qty::text,'unitPrice',l.unit_price::text,'projectId',l.project_id) ORDER BY l.line_number) " +
      "FILTER(WHERE l.id IS NOT NULL),'[]'::jsonb) AS lines " +
      "FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN projects p ON p.id=po.project_id " +
      "LEFT JOIN purchase_order_lines l ON l.purchase_order_id=po.id LEFT JOIN inventory_items i ON i.id=l.item_id " +
      "GROUP BY po.id,s.name,p.code ORDER BY po.created_at DESC LIMIT 200",
  );
  return result.rows;
}

export async function createPurchaseOrder(body: Record<string, unknown>, user: AuthenticatedUser) {
  const poNumber = shortText(body.poNumber, "poNumber", 60).toUpperCase();
  const supplierId = requireUuid(body.supplierId, "supplierId");
  const projectId = body.projectId ? requireUuid(body.projectId, "projectId") : null;
  const orderDate = optionalDate(body.orderDate, "orderDate");
  const expectedDelivery = optionalDate(body.expectedDelivery, "expectedDelivery");
  const notes = optionalText(body.notes, "notes", 2000);
  const lines = parseLines(body.lines);
  return inTransaction(async (client) => {
    const supplier = await client.query("SELECT id FROM suppliers WHERE id=$1 AND is_active=true", [supplierId]);
    if (!supplier.rowCount) throw new HttpError(404, "SUPPLIER_NOT_FOUND", "An active supplier is required.");
    if (projectId) await requireProject(client, projectId);
    if (expectedDelivery && orderDate && expectedDelivery < orderDate) {
      throw new HttpError(400, "INVALID_DELIVERY_DATE", "Expected delivery cannot precede the order date.");
    }
    const order = await client.query<{ id: string }>(
      "INSERT INTO purchase_orders(po_number,supplier_id,project_id,order_date,expected_delivery,notes,created_by) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [poNumber, supplierId, projectId, orderDate, expectedDelivery, notes, user.id],
    );
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const item = await client.query<{ id: string }>(
        "SELECT id FROM inventory_items WHERE sku=$1 AND is_active=true",
        [line.sku],
      );
      if (!item.rowCount) throw new HttpError(404, "ITEM_NOT_FOUND", `Inventory SKU ${line.sku} was not found or is inactive.`);
      const lineProject = line.projectId ?? projectId;
      if (lineProject) await requireProject(client, lineProject);
      await client.query(
        "INSERT INTO purchase_order_lines(purchase_order_id,line_number,item_id,project_id,ordered_qty,unit_price,expected_delivery) " +
          "VALUES($1,$2,$3,$4,$5,$6,$7)",
        [order.rows[0].id, index + 1, item.rows[0].id, lineProject, line.quantity, line.unitPrice, expectedDelivery],
      );
    }
    await audit(client, user, "purchase_order.created", "purchase_order", order.rows[0].id, {
      poNumber, supplierId, projectId, lineCount: lines.length,
    });
    return { id: order.rows[0].id };
  });
}

export async function updatePurchaseOrderStatus(
  orderId: string,
  next: unknown,
  user: AuthenticatedUser,
) {
  if (next !== "submitted" && next !== "ordered" && next !== "cancelled") {
    throw new HttpError(400, "INVALID_STATUS", "Choose submitted, ordered, or cancelled.");
  }
  return inTransaction(async (client) => {
    const order = await client.query<{ status: string }>(
      "SELECT status FROM purchase_orders WHERE id=$1 FOR UPDATE",
      [orderId],
    );
    if (!order.rowCount) throw new HttpError(404, "NOT_FOUND", "Purchase order not found.");
    const current = order.rows[0].status;
    const allowed: Record<string, string[]> = {
      draft: ["submitted", "cancelled"],
      submitted: ["ordered", "cancelled"],
      ordered: ["cancelled"],
    };
    if (!allowed[current]?.includes(next)) {
      throw new HttpError(409, "INVALID_TRANSITION", `Purchase order cannot change from ${current} to ${next}.`);
    }
    if (next === "cancelled") {
      const received = await client.query("SELECT 1 FROM purchase_order_lines WHERE purchase_order_id=$1 AND received_qty>0", [orderId]);
      if (received.rowCount) throw new HttpError(409, "ALREADY_RECEIVED", "Orders with received items cannot be cancelled.");
    }
    await client.query("UPDATE purchase_orders SET status=$2,updated_at=now() WHERE id=$1", [orderId, next]);
    await audit(client, user, "purchase_order.status_changed", "purchase_order", orderId, { from: current, to: next });
    return { id: orderId, status: next };
  });
}

export async function receivePurchaseOrderLine(
  orderId: string,
  body: Record<string, unknown>,
  user: AuthenticatedUser,
) {
  const lineId = requireUuid(body.lineId, "lineId");
  const quantity = positive(body.quantity, "quantity");
  const location = shortText(body.location, "location", 160);
  const bin = shortText(body.bin, "bin", 100);
  const key = shortText(body.idempotencyKey, "idempotencyKey", 128);
  const authorizeOverage = body.authorizeOverage === true;
  if (key.length < 8) throw new HttpError(400, "INVALID_KEY", "An idempotency key of at least 8 characters is required.");
  if (authorizeOverage && user.role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "Only an administrator can authorize a receipt overage.");
  }
  return inTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["purchase-receipt:" + key]);
    const previous = await client.query<{
      id: string; purchase_order_line_id: string; quantity: string; location: string; bin: string; overage_authorized_by: string | null;
    }>(
      "SELECT id,purchase_order_line_id,quantity::text,location,bin,overage_authorized_by FROM purchase_receipts WHERE idempotency_key=$1",
      [key],
    );
    if (previous.rowCount) {
      const row = previous.rows[0];
      const quantityMatches = await client.query<{ matches: boolean }>(
        "SELECT quantity=$1::numeric AS matches FROM purchase_receipts WHERE id=$2",
        [quantity, row.id],
      );
      if (row.purchase_order_line_id !== lineId || !quantityMatches.rows[0].matches ||
          row.location !== location || row.bin !== bin) {
        throw new HttpError(409, "KEY_REUSED", "The receipt idempotency key was already used for different details.");
      }
      return { id: row.id, replayed: true };
    }
    const line = await client.query<{
      id: string; status: string; item_id: string; ordered_qty: string; received_qty: string;
      unit_price: string; project_id: string | null; po_id: string; po_number: string;
    }>(
      "SELECT l.id,po.status,l.item_id,l.ordered_qty::text,l.received_qty::text,l.unit_price::text,l.project_id, " +
        "po.id AS po_id,po.po_number FROM purchase_order_lines l " +
        "JOIN purchase_orders po ON po.id=l.purchase_order_id WHERE l.id=$1 AND po.id=$2 FOR UPDATE OF l,po",
      [lineId, orderId],
    );
    if (!line.rowCount) throw new HttpError(404, "LINE_NOT_FOUND", "Purchase order line not found.");
    const row = line.rows[0];
    if (!["submitted", "ordered", "partially_received"].includes(row.status)) {
      throw new HttpError(409, "INVALID_STATUS", "This purchase order is not open for receiving.");
    }
    const amount = await client.query<{ within_order: boolean }>(
      "SELECT $1::numeric+$2::numeric <= $3::numeric AS within_order",
      [row.received_qty, quantity, row.ordered_qty],
    );
    if (!amount.rows[0].within_order && !authorizeOverage) {
      throw new HttpError(409, "RECEIPT_OVERAGE", "Receipt exceeds the ordered quantity; administrator authorization is required.");
    }
    await client.query(
      "INSERT INTO inventory_stock(item_id,location,bin,on_hand,updated_by) VALUES($1,$2,$3,$4,$5) " +
        "ON CONFLICT(item_id,location,bin) DO UPDATE SET on_hand=inventory_stock.on_hand+EXCLUDED.on_hand,updated_at=now(),updated_by=EXCLUDED.updated_by",
      [row.item_id, location, bin, quantity, user.id],
    );
    const movement = await client.query<{ id: string }>(
      "INSERT INTO inventory_movements(item_id,movement_type,quantity_delta,to_location,to_bin,reference,actor_user_id,idempotency_key) " +
        "VALUES($1,'receipt',$2::numeric,$3,$4,$5,$6,$7) RETURNING id",
      [row.item_id, quantity, location, bin, `PO ${row.po_number}`, user.id, `po-receipt:${key}`],
    );
    const receipt = await client.query<{ id: string }>(
      "INSERT INTO purchase_receipts(purchase_order_line_id,quantity,location,bin,inventory_movement_id,idempotency_key,overage_authorized_by,received_by) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [lineId, quantity, location, bin, movement.rows[0].id, key, authorizeOverage ? user.id : null, user.id],
    );
    await client.query(
      "UPDATE purchase_order_lines SET received_qty=received_qty+$2::numeric WHERE id=$1",
      [lineId, quantity],
    );
    const pending = await client.query(
      "SELECT 1 FROM purchase_order_lines WHERE purchase_order_id=$1 AND received_qty<ordered_qty LIMIT 1",
      [orderId],
    );
    const anyReceived = await client.query(
      "SELECT 1 FROM purchase_order_lines WHERE purchase_order_id=$1 AND received_qty>0 LIMIT 1",
      [orderId],
    );
    const status = pending.rowCount ? (anyReceived.rowCount ? "partially_received" : row.status) : "received";
    await client.query("UPDATE purchase_orders SET status=$2,updated_at=now() WHERE id=$1", [orderId, status]);
    if (row.project_id) {
      await client.query(
        "INSERT INTO project_cost_entries(project_id,cost_type,description,source,unit,quantity,actual_unit_cost,source_reference,created_by) " +
          "SELECT $1,'material',i.name,'purchase_order',i.unit,$2::numeric,$3::numeric,$4,$5 FROM inventory_items i WHERE i.id=$6",
        [row.project_id, quantity, row.unit_price, `PO ${row.po_number}`, user.id, row.item_id],
      );
    }
    await audit(client, user, "purchase_order.received", "purchase_order", orderId, {
      lineId, receiptId: receipt.rows[0].id, quantity, location, bin, overageAuthorized: authorizeOverage,
    });
    await audit(client, user, "inventory.receipt", "inventory_item", row.item_id, { purchaseOrder: orderId, quantity, location, bin });
    return { id: receipt.rows[0].id, status, replayed: false };
  });
}
