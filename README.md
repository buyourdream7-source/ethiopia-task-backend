# Ethiopia Task — Backend (MVP)

Real REST API for the Ethiopia Task marketplace: Postgres schema, JWT auth,
worker search, the full booking lifecycle with commission splitting, reviews,
basic chat, and an admin dashboard API. No fake data, no mocked payment
confirmations — payment status is a real state machine (`pending` → `paid` /
`failed` / `refunded`) that you wire up to a real Ethiopian payment provider
when you're ready (see "Adding a payment provider" below).

## 1. Requirements

- Node.js 18+
- A Postgres database (14+). Any host works: [Railway](https://railway.app),
  [Render](https://render.com), [Neon](https://neon.tech), or a local install.

## 2. Setup

```bash
cd ethiopia-task-backend
npm install
cp .env.example .env
# edit .env: set DATABASE_URL to your Postgres connection string,
# and JWT_SECRET to a random string (openssl rand -hex 32)

npm run migrate      # creates all tables and seeds the 12 categories
npm run dev           # starts the API on http://localhost:4000
```

Check it's alive: `curl http://localhost:4000/health` → `{"ok":true}`

Create your first admin (admins can't be created through the public API):

```bash
node scripts/create-admin.js +251911111111 "Admin Name" a-strong-password
```

## 3. Connecting the frontend prototype

The React prototype (`ethiopia-task-app.jsx` from earlier) currently runs on
mock in-memory state. To connect it to this real API, swap each mock
action for a `fetch` call, e.g.:

```js
const res = await fetch(`${API_URL}/api/workers?category=electrician&lat=9.03&lng=38.74`);
const workers = await res.json();
```

Store the JWT from `/api/auth/login` (e.g. in memory or secure storage — never
`localStorage` in a Claude artifact) and send it as
`Authorization: Bearer <token>` on every subsequent request.

## 4. API overview

| Area | Endpoint | Notes |
|---|---|---|
| Auth | `POST /api/auth/register` | customer or worker signup |
| Auth | `POST /api/auth/login` | returns JWT |
| Users | `GET/PATCH /api/users/me` | profile |
| Users | `GET/POST /api/users/me/addresses` | saved locations |
| Categories | `GET /api/categories` | the 12 seeded categories |
| Workers | `GET /api/workers` | search: `category`, `lat`, `lng`, `radius_km`, `min_rating`, `verified_only`, `sort` |
| Workers | `GET /api/workers/:id` | profile, services, reviews |
| Workers | `PATCH /api/workers/me/profile` | worker only |
| Workers | `PUT /api/workers/me/categories` | worker sets services + prices |
| Workers | `POST /api/workers/me/documents` | submits ID for verification |
| Bookings | `POST /api/bookings` | customer requests a worker |
| Bookings | `GET /api/bookings` / `GET /api/bookings/:id` | role-scoped |
| Bookings | `PATCH /api/bookings/:id/status` | enforces the legal state machine below |
| Reviews | `POST /api/bookings/:bookingId/review` | after `confirmed` |
| Chat | `GET/POST /api/conversations/:bookingId/messages` | |
| Admin | `GET /api/admin/stats` | dashboard numbers |
| Admin | `GET/PATCH /api/admin/verifications` | approve/reject workers |
| Admin | `GET/PATCH /api/admin/disputes` | |
| Admin | `PATCH /api/admin/settings/commission` | configurable commission rate |
| Admin | `PATCH /api/admin/users/:id/suspend` | |

## 5. Booking status machine

```
requested → accepted → on_the_way → started → completed → confirmed
    └──────────┴───────────┴──────────┘
              (any of these → cancelled)
      completed / any → disputed
```

- `requested → accepted → on_the_way → started → completed`: only the **worker** moves these.
- `→ confirmed`: only the **customer** — this is what actually settles payment,
  calculates the commission split, and increments the worker's completed-job count.
- `cancelled` / `disputed`: either party, depending on stage.

Commission is read from `platform_settings` at the moment of confirmation and
snapshotted onto the booking (`commission_rate`, `commission_amount`,
`worker_earnings`) — so changing the platform rate later never rewrites
historical earnings.

## 6. Adding a real Ethiopian payment provider

The `payments` table and status flow are already provider-agnostic. To wire up
a real provider (e.g. Chapa or Telebirr):

1. On booking creation, call the provider's checkout/initiate API and store
   the returned reference in `payments.provider_reference`.
2. Handle their webhook: on success, set `payments.status = 'paid'`; on
   failure, `'failed'`.
3. Never mark a payment `paid` from the client — only from a verified
   server-to-server webhook call.

## 7. Deploying

Any Node host works (Railway, Render, Fly.io). Typical flow:

1. Push this folder to a Git repo.
2. Create a Postgres instance on your host, copy its connection string into
   `DATABASE_URL`.
3. Set `JWT_SECRET` and `CORS_ORIGIN` (your frontend's real domain) as
   environment variables.
4. Run `npm run migrate` once against the production database.
5. Deploy — the platform will run `npm start`.

## 8. What's intentionally not in the MVP

Per the original brief, these are designed for but not built yet, so the
schema/API won't need to change when you add them:

- Real-time push notifications (the `notifications` table is ready; wire up
  FCM/APNs or SMS when needed)
- AI matching, price estimation, fraud detection, translation
- GPS live tracking (worker location is currently a static base point + radius)
