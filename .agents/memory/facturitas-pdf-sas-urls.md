---
name: Facturitas PDF SAS URLs expire
description: Why stored Facturitas invoice/NC PDF links break over time and how to serve them
---

# Facturitas PDF links are time-limited SAS URLs

Facturitas (electronic invoicing provider, ARCA) does NOT serve invoice/NC PDFs
from its API host. It returns a `pdf_url` / `credit_note_pdf_url` that points to
a **time-limited SAS-signed Azure Blob URL** on `apifacturitas.blob.core.windows.net`.
The signature expires; opening an OLD stored link fails with Azure's
"AuthenticationFailed / Signed expiry time must be after signed start time".

**Rule:** never serve a persisted Facturitas PDF URL directly to the browser for
old comprobantes. Re-fetch a fresh link from the provider by uuid
(`GET /invoices/{uuid}` → `pdf_url`; for NC, `GET /invoices/{originalUuid}` →
`credit_note_pdf_url`) and 302-redirect to it at view time.

**Why:** the URL captured at emission is only valid for a short window; reusing
it always breaks once the SAS expires (new invoices work, old ones don't).

**How to apply:**
- Server endpoint `GET /api/invoicing/transactions/:id/pdf?type=invoice|creditNote`
  re-fetches via `fetchFreshPdfUrl` (server/services/facturita.ts) and redirects.
- `requireAuth` authenticates by session cookie (bearer is only a fallback), so a
  plain `<a href>` / `window.open` navigation authenticates on its own — no need
  for an authenticated fetch + token header on these links.
- The SSRF allowlist `ALLOWED_PDF_HOST_SUFFIXES` (server/routes/invoicing.ts) must
  include the exact host `apifacturitas.blob.core.windows.net`. The legacy
  `.facturita.com` entries never matched the real blob host, so the zip export was
  silently dropping real provider PDFs too. Pin the specific blob host, NOT the
  wildcard `.blob.core.windows.net` (SSRF to arbitrary Azure tenants).
- `invoiceFileUrl` is a USER-uploaded attachment in object storage — unrelated to
  the provider PDF (`invoicePdfUrl`). Do not route it through this refresh flow.
