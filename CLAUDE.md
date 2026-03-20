# Roku Integration Extension — Claude Code Guide

## What Is This?

A Waiveo community extension that discovers and controls Roku devices on the local network. Uses Roku's External Control Protocol (ECP) on port 8060.

**Requires:** `device-discovery` extension | **Provides:** `roku-control` capability | **Permissions:** `network`, `database`

## Project Structure

```
roku-integration/
├── extension.json          # Extension manifest (v1.3.0, type: community)
├── package.json            # Dependencies (xml2js)
├── README.md               # User documentation
├── automation.json         # 4 triggers + 4 actions
├── discovery.json          # SSDP/ECP device discovery config
├── navigation.json         # Sidebar entry ("Roku", order 60)
├── server/
│   ├── index.js            # Main backend (1390 lines) — device management, API routes, automation
│   └── RokuClient.js       # Roku ECP protocol client (392 lines) — HTTP/XML communication
└── frontend-routes/
    └── roku-integration/
        └── +page.svelte    # UI — device list, remote control modal, settings
```

## Key Architecture

### Device Lifecycle
1. **Discovery:** Registers interest in port 8060 devices via `globalEventBus` → `discovery:register-interest`
2. **Matching:** Listens for `discovery:candidate-matched`, probes `/query/device-info` for serial number
3. **Registration:** Creates device in local `roku_devices` table + centralized `device_registry` (type: `roku`, ID: `roku:<serial>`)
4. **Polling:** Registers adapter with DevicePollingManager (750ms interval) → updates `entity_states`
5. **Recovery:** On startup, recovers orphaned devices from `entity_states` if local table is empty

### Entity States
- `media_player.<device_slug>` — States: `off`, `on`, `playing`, `idle`
- Attributes: `power_mode`, `power_state`, `active_app`, `active_app_id`, `app_type`, `is_screensaver`

### RokuClient.js
Low-level ECP protocol. XML responses parsed with `xml2js`. 5-second timeout default.
- Device info, app list, active app, media player state
- Keypress, app launch, power on/off, volume, text input

## API Routes

All under `/api/extensions/roku-integration/`:

- `GET /devices` — List all Roku devices
- `GET /devices/:id` — Device details
- `GET /devices/:id/apps` — Installed apps
- `GET /devices/:id/active-app` — Currently running app
- `GET /devices/:id/info` — Full device info
- `GET /devices/:id/access` — Mobile control access level
- `POST /devices/:id/keypress/:key` — Send remote key
- `POST /devices/:id/launch/:appId` — Launch app
- `POST /devices/:id/power/on|off` — Power control
- `POST /devices/add` — Manual device registration by IP
- `DELETE /devices/:id` — Remove device
- `GET|PUT /settings` — Extension settings

## Automation

**Triggers (state-based):** `Roku turned on`, `Roku turned off`, `Roku started playing`, `Roku went idle`

**Actions:** `power_on`, `power_off`, `launch_app`, `send_keypress`

**Supported Keys:** Home, Back, Select, Up, Down, Left, Right, Play, Pause, Rev, Fwd, VolumeUp, VolumeDown, VolumeMute

## Database

**Model: `roku_devices`** — `device_id`, `ip_address`, `name`, `model`, `serial_number`, `software_version`, `power_mode`, `status`, `metadata` (JSON), `last_seen_at`, `created_at`

## Dependencies

- `xml2js` ^0.6.2 — Parse Roku XML responses

## Deployment

```bash
cd /Users/matt/waiveo/waiveo
./scripts/cli/deploy-cli.sh extension roku-integration
```

## Cross-Project Escalation

If you encounter a problem outside this project's boundary:
1. Write an issue file to `../issues/` following the workspace issue template (see workspace `CLAUDE.md` for format)
2. Set `source-project` to `roku-integration`
3. Set `assigned-project` if you know who owns it, otherwise `unassigned`
4. Include specific acceptance criteria so the fixing agent can verify without a round-trip
5. Always set severity — if `critical`, tell the user: "I've filed a critical cross-project issue — you may want to dispatch this from the workspace level."
6. Note the dependency in your current work and continue

## Check Assigned Issues

Before starting work, scan `../issues/` for files where `assigned-project` is `roku-integration` and `status` is `assigned` or `in-progress`. Mention any open issues to the user before proceeding with other work.
