# Aikestar - Sistema de Gestión Administrativa e Inteligente

## Overview
Aikestar is an AI-powered administrative and accounting management system for SMEs and entrepreneurs, focusing on the Spanish-speaking market. It centralizes financial movements, basic administration, and reporting through a guided user experience. The project aims to provide comprehensive financial management, scale with CRM functionalities, and deliver advanced analytics, including multi-organization support, AI-driven financial analysis, and integrated reporting for a complete financial overview.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React with TypeScript and Vite
- **UI/UX**: Futuristic fintech aesthetic (cyan/pink palette, Space Grotesk typography, gradient texts, glassmorphism) featuring a dashboard with "Foto" (current balances) and "Película" (economic state) views, a financial health bar, and AI-powered custom reports. Transaction UX includes circular badges, educational dialogs, and a streamlined 4-step wizard with recurrence options.
- **State Management**: TanStack Query
- **UI Components**: shadcn/ui (Radix UI)
- **Styling**: Tailwind CSS v4

### Backend
- **Framework**: Express.js with TypeScript
- **API Pattern**: RESTful API
- **Authentication**: Session-based with bearer tokens

### Data Storage
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM
- **Schema**: Core data models for Users, Organizations, Accounts, Transactions, Clients, Suppliers, Products, Assets, Investments, and Audit Logs.

### AI Integration
- **Provider**: OpenAI via Replit AI Integrations
- **Features**: Transaction classification, financial health analysis, bank statement analysis (image/PDF upload), transaction pattern analysis, and voice-to-text transcription.
- **Web Chat (Aike)**: Provides help and guidance, answers app and financial questions, and analyzes user data.
- **WhatsApp Bot**: Twilio-based for transaction registration with smart defaults and personalization.

### System Design Choices
- **Multi-Organization Support**: Segregated data for multiple organizations.
- **Role-Based Permissions**: Distinct access levels (Operators, Specialists, Owners/Admins).
- **Financial Account Categories**: Two-tier classification (operative/investment) with performance tracking.
- **Financial Health Score**: A 0–100 score based on key financial metrics.
- **Transaction Traceability**: Links expenses/payables to source income/receivables.
- **Recurring Transactions**: Automatic generation of commitments.
- **Undo/Cancellation System**: Toast-based undo for deletions and transaction approvals; cancellation creates inverse records.
- **Stock-Transaction Integration**: Transactions with products atomically affect stock levels.
- **Notification System**: Dual-tab system for pending commitments and historical notifications.
- **Data Retention Policy**: Soft-deletes inactive accounts; retains user data for 60 days post-subscription cancellation.
- **Costo vs Gasto Separation**: Differentiates production-related costs (`Costo`) from operational/administrative expenses (`Gasto`).
- **Impuestos (Taxes) Section**: Provides an informational page with IVA, IIBB, and Ganancias estimates, detailed sales/purchases tables, and tax configuration management.
- **Electronic Invoicing (ARCA via Facturitas)**: Integrates with an internal provider for electronic invoice emission, credit notes, and associated settings, controlled by client and server-side feature flags.
- **Calendar Logic**: Source of truth for financial movements, with policies for date bucketing, exclusion of cancelled/internal transfer transactions from totals, and a clear split between real and committed financials.
- **Auto-Apply Payments to Commitments**: Automatically applies payments against pending payables/receivables.
- **Reports Card/Detail Parity**: Ensures consistency between report card totals and drill-down modal totals.
- **Códigos de Análisis de Rentabilidad**: Transversal tagging entity for non-transfer transactions and products, managed via settings, and integrated into transaction creation and reports.
- **WhatsApp Integration**: Includes a pre-flight linking process requiring the user to initiate contact with the bot, a 3-step verification wizard for phone number linking, and post-linking confirmation messages via WhatsApp and email.
- **Inline Creation of Payment Methods**: Allows owners/admins to create new payment methods directly from the transaction wizard via a dedicated editor dialog.
- **WhatsApp Phone Verification**: Secure 6-digit code verification with bcrypt hashing, 10-min TTL, rate limits, and anti-enumeration measures.
- **Session Stability Hardening (production fix)**: Two surgical changes to stop paying users from being kicked out on transient errors. (1) `client/src/lib/api.ts` no longer does `window.location.href = '/login'` on every 401 — instead it clears CSRF, invalidates the `['user']` query, and throws. `App.tsx` reacts to the user-query state, so genuine logouts still redirect but transient 401s on `/api/accounts`/`/api/transactions`/etc. no longer terminate the session. (2) `server/routes/middleware.ts` `requireAuth` now retries `storage.getUser(userId)` once after a 150 ms backoff before destroying the session. If the retry throws, the middleware fails open (preserves session, calls `next()`); if it returns null again, behavior is unchanged (destroy session + 401 USER_DELETED). The `deletedAt` soft-delete branch is untouched, so legitimate account deletions still log the user out.
- **Security Hardening (Sprint 1)**: XSS removed in `client/src/pages/transactions.tsx` invoice-error handler (DOM API + URL scheme allowlist instead of `innerHTML`). AES-GCM in `server/services/invoicingCrypto.ts` now passes explicit `authTagLength: 16` to `createCipheriv`/`createDecipheriv` and validates tag length before decryption (backward compatible with existing payloads). Removed diagnostic `console.log` lines that referenced auth-token presence (Stripe live key boolean, Twilio token presence, recovery/auth token booleans) for GDPR/NIST compliance. `fast-xml-parser` bumped to ^4.5.5 to close GHSA-m7jm-9gc2-mpf2.
- **Canonical Domain Enforcement**: In real Replit deployments (gated by `REPLIT_DEPLOYMENT=1`), an Express middleware issues 301 permanent redirects from any `*.replit.dev` / `*.replit.app` host to the canonical `aikestar.net` (derived from `APP_DOMAIN`), preserving path and query. Stripe/Twilio webhook paths are exempt so external callers keep working. A dynamic `/robots.txt` returns `Allow:/` on the canonical host and `Disallow:/` on any other host. Marketing/analytics scripts (GTM, Meta Pixel, Metricool, TikTok Pixel) in `client/index.html` are gated behind `window.__AIKESTAR_TRACKING_ENABLED__`, set true only when `hostname` is `aikestar.net` or `www.aikestar.net`, so conversions are never attributed under a non-canonical host. `<link rel="canonical">` and `og:url` point to `https://aikestar.net/`.
- **Production Database Migration to Customer-Owned Neon (May 2026)**: Production database moved from Replit-managed Neon (Free tier, scale-to-zero after 5 minutes causing recurrent cold-start outages) to a customer-owned Neon project on the Launch plan (always-on, autoscale 0.25 → 8 CU, us-east-2 / Ohio, same region as the Autoscale deployment to keep cross-region latency at zero). Migration was performed via `pg_dump -Fc` + `pg_restore --clean --if-exists --single-transaction` with downstream verification of all 42 tables / 62 indexes / row counts. To override the `DATABASE_URL` that Replit's "Production database connected" feature injects with priority over user secrets, `server/db.ts` now reads `process.env.NEON_OHIO_URL || process.env.DATABASE_URL` and logs `[DB] Connecting to <host> (source: NEON_OHIO_URL|DATABASE_URL)` on boot. Removing the `NEON_OHIO_URL` deployment secret is a one-step rollback to the legacy injected database. The original Replit-managed database remains intact (read-only fallback) and should be kept warm for at least 14 days post-cutover before being released.

## External Dependencies

### Database
- PostgreSQL

### UI/Development
- Radix UI primitives
- Lucide React
- Recharts
- date-fns

### AI Integration
- OpenAI (via Replit AI Integrations)
- Web Speech API

### Email Integration
- SendGrid

### Payment Gateway
- Stripe