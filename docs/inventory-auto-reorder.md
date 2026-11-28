# Inventory Auto Reorder — operator guide and release controls

**Status:** opt-in feature in the stacked development branch. Do not activate
commercial customer environments before the full release gate passes.

## How it works

Auto Reorder is **OFF by default**, for existing and new SKUs. Operators and
administrators can open an inventory item, check **Enable Auto Reorder**, and
save its reorder point and desired fixed replenishment quantity.

An enabled item is evaluated against **total on-hand inventory across all
locations and bins**, not the quantity in any one bin. The evaluator runs
inside the stock-changing transaction for:
- manual inventory receipts, issues, transfers, and counts;
- production material consumption;
- field-service part issues;
- maintenance part issues;
- enabling or changing the SKU's settings.

For other workflows or older records, click **Check reorder now** in the item
drawer to explicitly reconcile that SKU.

If inventory is at or below the configured reorder point and the item is
enabled, CloudForge creates **one internal purchase request** for the saved
replenishment quantity, awaiting human review. It *does not* create or
submit an external purchase order, email a supplier, take payment, approve
a purchase, or modify a machine. Every generated request is marked
`request_origin='auto_reorder'`, is associated with its organization, and
creates an audit event.

The system also checks for existing outstanding manual purchasing requests
and purchase-order lines before suggesting another purchase. A PostgreSQL
unique index prevents multiple unresolved automatic requests for the same
item in the same organization, even under concurrent stock updates.

### Disable Auto Reorder

Clear the **Enable Auto Reorder** checkbox and save. CloudForge stops creating
new automatic requests for that SKU immediately. Existing requests and
purchase orders are **not canceled, erased, or silently changed**. An
authorized purchasing user reviews or cancels them through the purchasing
workflow. Enabling the item again evaluates its stock at once.

### Example

An electrical terminal block has SKU `ELE-TB-001`, 100 units on hand,
a reorder point of 50, and an automatic replenishment quantity of 75.
If its inventory drops to 49 units through recorded usage and Auto Reorder
is enabled, CloudForge creates one internal purchase request for 75 units.
Further stock movements cannot create another request while the first is
still unresolved. Turning Auto Reorder off prevents additional suggestions,
but the existing request remains on record.

## Security and operational boundaries

Only authenticated organization operators and administrators may change
reorder policy or trigger an explicit recheck. Viewers can see stock and the
associated request status without changing policy. Organization identifiers
come from verified login membership; clients cannot override them.

Stock transfers between bins must never cause a false reorder, because only
the final total stock after the transfer is evaluated. Failed/replayed stock
transactions roll back together with their automatic request. Existing
unresolved manual requests and open supplier POs suppress duplicate automatic
requests. Closed, canceled, or fully received orders permit a later new
request if stock is still low.

## Out of scope (must not be implied)

No automatic vendor transmission, supplier payment, procurement authorization,
inventory forecasting, lead-time optimization, or purchase-order sending is
implemented by this feature. A future supplier-specific reorder policy,
safety stock, lead-time forecast, or explicit *approved auto-purchasing* module
would require separate controls and customer authorization.

## Acceptance checks

- Existing SKUs stay disabled on migration; historical balances and events
  remain unchanged.
- Enable an item already below threshold and verify a single pending request.
- Issue further stock and recheck; verify no duplicates.
- Move stock between bins; verify unchanged aggregate stock causes no reorder.
- Create an outstanding manual purchase request or PO; verify no duplicate.
- Disable, then issue stock; verify no new request and prior requests survive.
- Confirm role restrictions, cross-tenant isolation, audit, and that no external
  supplier order is sent.
- Check actual on-prem and PostgreSQL CI gates before publishing.
