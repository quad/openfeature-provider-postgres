# Example: Feature Flags Dashboard

A minimal Express app that displays live feature flag values using the Postgres
OpenFeature provider.

Flags update in real-time via Server-Sent Events — change a flag in Postgres and
the page refreshes automatically.

## Setup

```bash
# 1. Create a database
createdb flags

# 2. Install dependencies (links the local provider)
npm install

# 3. Seed demo flags (migration runs automatically on boot)
npm run seed

# 4. Start the server (with --watch for live reload)
npm start
```

Open http://localhost:3000 to see the flags dashboard.

Add `?user=user-123` to the URL to see rollout behavior (the "greeting" flag has
a 50/50 split).

## Demo flags

| Flag          | Type    | Behavior                                         |
| ------------- | ------- | ------------------------------------------------ |
| `dark-mode`   | boolean | Toggles page theme                               |
| `greeting`    | string  | 50% rollout — varies by `targetingKey`           |
| `max-items`   | number  | Standard (25) vs premium (100)                   |
| `banner`      | object  | Promo banner with text and color                 |
| `maintenance` | boolean | Disabled flag — always returns the default value |

## Try it

```sql
-- Toggle dark mode
UPDATE openfeature.feature_flags SET default_variant = 'on' WHERE flag_key = 'dark-mode';

-- Switch banner to holiday theme
UPDATE openfeature.feature_flags SET default_variant = 'holiday' WHERE flag_key = 'banner';

-- Enable maintenance mode
UPDATE openfeature.feature_flags SET enabled = true WHERE flag_key = 'maintenance';
```

The page updates instantly via LISTEN/NOTIFY.

## Environment variables

- `DATABASE_URL` — Postgres connection string (default:
  `postgres://localhost:5432/flags`)
- `PORT` — HTTP port (default: `3000`)
