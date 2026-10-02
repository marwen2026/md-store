# M&D Store — Final

## Features
- Real shopping cart with localStorage
- Checkout and server-side stock validation
- WhatsApp order confirmation
- Product search and categories
- Debounced storefront product search with stale-response protection
- Tunisian dinar (TND) prices and delivery fees displayed to millime precision
- Product CRUD/soft-hide
- Inventory movement history, out-of-stock alerts, and best-selling products
- Inventory report exports in Excel-compatible CSV and PDF formats
- Out-of-stock products remain visible in the storefront and featured carousel; ordering is disabled until restocked
- WhatsApp orders are recorded without reducing stock until an administrator confirms them; cancelling a confirmed order returns its stock
- Admin dashboard data refreshes automatically every second and when returning to the tab, without interrupting active edits
- Multiple product images + image deletion
- Orders, customers, statuses
- Per-order status history and administrator activity log
- PDF invoices
- Admin/manager permissions
- PostgreSQL database

## Run with Docker
1. Install and start Docker Desktop.
2. Copy `.env.example` to `.env` and replace `JWT_SECRET`, `POSTGRES_PASSWORD`, and `ADMIN_PASSWORD` with private values. Keep the password in `DATABASE_URL` in sync if you also plan to run Node directly on Windows.
3. From this directory, run `docker compose up -d --build`.
4. Open the storefront at `http://localhost:3000` and the administration at `http://localhost:3000/admin`.

The app waits for PostgreSQL to become healthy, then creates its tables and first admin account. The Docker database is published on host port `5433` so it can coexist with a PostgreSQL server already listening on `5432`. In pgAdmin, register a server with host `127.0.0.1`, port `5433`, database `md_store`, username `postgres`, and the `POSTGRES_PASSWORD` value from `.env`. Change `POSTGRES_PORT` in `.env` if port 5433 is already occupied.

`docker compose down` stops the services and preserves database and upload volumes. `docker compose down -v` permanently deletes those volumes and their data.

To run Node directly on Windows instead, install Node.js 18+, start PostgreSQL, set `DATABASE_URL` in `.env`, then run `npm install` and `npm start`.

Use strong, unique passwords and a random `JWT_SECRET` of at least 32 characters in production. Set `PGSSL=true` when connecting to a remote PostgreSQL server that requires SSL.

This starts with an empty PostgreSQL database; existing SQLite data is not imported automatically.

## Design
The storefront UI is styled as an RTL luxury fashion store inspired by the supplied M&D reference: black/gold top bar, premium header, hero banner, service strip, categories, bestseller cards, special-offer panel, cart drawer and WhatsApp checkout.

Branding update: the storefront displays only “M&D”; “MARWEN & DORRA” has been removed from the visible branding.

## Historique

Voir [HISTORY.md](./HISTORY.md) pour l'historique fonctionnel du projet et les
évolutions prévues. Les administrateurs peuvent consulter cet historique et le
journal des actions depuis le back-office.

## Présentation

Voir [PROJECT-PRESENTATION.md](./PROJECT-PRESENTATION.md) pour un résumé, un
plan de présentation et un scénario de démonstration.
