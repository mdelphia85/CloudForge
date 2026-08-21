# Cloud Forge frontend product blueprint

Cloud Forge should feel like an industrial operating system: fast for daily work, clear under pressure, and deep enough for planning, execution, compliance, and service. The frontend should make the relationship between materials, people, projects, equipment, and customer commitments visible without forcing every role into the same dashboard.

## Product shell

### Global navigation

- Command center
- Inventory and warehouse
- Purchasing and suppliers
- Projects and planning
- Engineering and documents
- Work orders and field service
- Manufacturing floor
- Equipment and maintenance
- Quality and safety
- Analytics and forecasting
- Administration

Use a collapsible rail on desktop, a bottom or drawer navigation on mobile, and role-aware navigation that hides inaccessible modules without making security depend on the UI.

### Global utilities

- Universal search across authorized items, work orders, projects, people, documents, assets, and customers
- Command palette for keyboard-first actions
- Scan action for barcode and QR workflows
- Notifications grouped by urgency and owner
- Saved views and filters
- Context switcher for tenant, organization, site, warehouse, department, and project
- Activity and audit history on every important record
- Help, system status, sync status, and current user/session controls

## Role workspaces

### Operations command center

The first screen should answer: What needs attention, what is blocked, and what will be late?

- Critical shortages and reorder risks
- Production jobs at risk
- Field technicians currently dispatched
- Open safety or quality issues
- Overdue approvals and engineering changes
- Supplier and shipment exceptions
- Capacity and labor pressure
- AI recommendations with evidence, confidence, owner, and approval state

### Inventory and warehouse

- Item master with SKU, units, categories, lots, serials, substitutes, and attachments
- Stock by location, bin, truck, project, and status
- Receive, put-away, pick, pack, ship, transfer, issue, return, and adjust workflows
- Cycle count workspace with variance review
- Barcode/QR scan mode with large touch targets
- Reorder and shortage workbench
- Mobile-first offline mode for warehouse and field use

### Projects and engineering

- Portfolio and project dashboards
- Timeline, milestones, dependencies, baseline, critical path, and change history
- BOM and material readiness view
- Engineering request queue
- Review and approval lanes
- CAD/document preview with revision comparison
- ECO workflow showing affected parts, inventory, work orders, and approvals

### Manufacturing

- Floor board by station and work center
- Schedule, load, machine availability, and shift plan
- Job start/stop and operator assignment
- Material consumption, scrap, output, and downtime capture
- Quality checks embedded at the production step
- Large-display floor mode with clear status colors and low interaction cost

### Field service

- Dispatch board with map and route timeline
- Technician day view with travel, work, breaks, and constraints
- Work order detail with customer, asset, parts, instructions, safety, photos, and signatures
- On-site inventory and truck replenishment
- Offline-first capture for notes, signatures, photos, and parts usage
- Customer-facing service status without exposing internal data

### Equipment, quality, and safety

- Asset profile with serial, location, warranty, maintenance, repair, and documents
- Preventive maintenance calendar and failure history
- Inspection templates and mobile checklists
- Defect, non-conformance, corrective action, and verification workflow
- Incident reporting and training records
- Evidence-ready audit views with immutable event history

## Record experience

Every major object should share a consistent detail layout:

- Header with status, owner, identifier, location, and primary action
- Summary facts with clear source and last updated time
- Tabs for activity, related records, documents, costs, approvals, and audit history
- Right-side action rail on desktop and bottom action sheet on mobile
- Timeline that combines human actions, system events, and AI recommendations
- Explicit loading, empty, error, stale-data, offline, and permission-denied states

The most valuable frontend investment after the inventory table is a reusable record detail drawer/page. Items, work orders, projects, assets, suppliers, and engineering requests should all use the same interaction grammar.

## Industrial interaction patterns

- Keep primary workflows to one focused task per screen.
- Use keyboard shortcuts and command palette for office users.
- Use scan-first, touch-first controls for warehouse and field workers.
- Never rely on color alone for status; pair it with text and icons.
- Show the consequence of an action before confirmation: affected quantity, location, job, customer, or cost.
- Preserve drafts and queued actions when offline.
- Make unsaved, pending sync, conflict, stale, and confirmed states unmistakable.
- Prefer dense tables for comparison and spacious cards only for summaries or exceptions.
- Keep audit history one click away from every material or controlled change.

## AI experiences

AI should appear where it reduces cognitive load, not as decoration:

- Inventory copilot: reorder, shortage, anomaly, and substitute recommendations
- Production copilot: bottleneck and schedule risk explanations
- Field copilot: route, technician, and parts readiness suggestions
- Project copilot: delay risk, task assignment, and material readiness
- Engineering copilot: revision impact and related-record discovery
- Universal assistant: authorized natural-language search with citations

Every AI result needs evidence, confidence, data freshness, model/provider label, and a human approval path. The UI must distinguish recommendation, approved action, queued action, and completed action.

## UX quality bar

- Responsive desktop, tablet, rugged handheld, and large floor-display layouts
- WCAG 2.2 AA target with keyboard navigation and readable contrast
- Fast first render and progressively loaded dashboards
- Virtualized tables for large inventories and activity histories
- Optimistic UI only when rollback and sync states are visible
- Consistent date, time zone, quantity, currency, and unit formatting
- Exportable views with visible filters and generation time
- Print-friendly work orders, pick lists, labels, inspection sheets, and audit reports
- Localization-ready copy and measurement settings

## Frontend build order

1. Reusable application shell, command palette, search, notifications, context switcher, and permission-aware navigation.
2. Reusable record detail experience with timeline, related records, documents, and audit tabs.
3. Inventory table, item detail, add/edit, receive, transfer, cycle count, and scan workflows.
4. Work order and field service experience with mobile/offline states.
5. Project, BOM, engineering request, document revision, and ECO experience.
6. Manufacturing floor and production scheduling experience.
7. Quality, safety, equipment, supplier, customer, and portal experiences.
8. Analytics, forecasting, AI approval surfaces, and configurable dashboards.
9. Visual regression, accessibility, large-data performance, and offline interaction testing.

## What makes it feel exceptional

- Every dashboard is actionable: clicking an exception opens the exact record and next decision.
- Every record tells a connected story across material, work, person, machine, customer, and cost.
- Every workflow makes ownership, timing, evidence, and next step obvious.
- The interface works for an office planner, a warehouse operator, a technician in a truck, and a supervisor on a production floor.
- The product remains calm under pressure: clear hierarchy, restrained motion, visible system state, and no mystery automation.
