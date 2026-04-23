# roku-integration — Architecture Map

Waiveo community extension that discovers and controls Roku devices on the local network via Roku's External Control Protocol (ECP, port 8060).

## Entry points

| File | Purpose |
|---|---|
| `server/index.js` (~1390 lines) | Backend main — device lifecycle, API routes, automation handlers |
| `server/RokuClient.js` (~392 lines) | ECP protocol client — HTTP/XML to devices |
| `frontend-routes/roku-integration/+page.svelte` | UI — device list, remote control modal, settings |
| `extension.json` | Manifest — v1.3.0, type=community, requires `device-discovery`, provides `roku-control` |

## Major modules

### Device lifecycle (server/index.js)
1. Register interest in port-8060 devices via `globalEventBus.emit('discovery:register-interest')`.
2. Listen for `discovery:candidate-matched`, probe `/query/device-info` for serial.
3. Persist in local `roku_devices` table + global `device_registry` (type=`roku`, id=`roku:<serial>`).
4. Register poll adapter (DevicePollingManager, 750 ms interval) — updates `entity_states`.
5. On startup, recover orphaned devices from `entity_states` if local table is empty.

### RokuClient (server/RokuClient.js)
Low-level ECP. XML parsed via `xml2js`. 5 s default timeout. Methods: device info, app list, active app, media player state, keypress, launch, power on/off, volume, text input.

### Automation surface (automation.json)
- Triggers (state-based): `Roku turned on`, `Roku turned off`, `Roku started playing`, `Roku went idle`.
- Actions: `power_on`, `power_off`, `launch_app`, `send_keypress`.
- Supported keypresses: Home, Back, Select, directional, Play, Pause, Rev, Fwd, VolumeUp/Down/Mute.

## Data flow

```
SSDP/ECP discovery → device-discovery extension → discovery:candidate-matched event
  → roku-integration probes /query/device-info → registers in roku_devices + device_registry
  → DevicePollingManager polls every 750ms → api.setState(media_player.<slug>, <state>)
  → StateManager emits state_changed → automation TriggerManager evaluates triggers
```

Entity state normalization: `interpretPowerState()` maps raw Roku values → normalized (`poweron`→`on`, `standby`→`off`, etc.). **Automations must use normalized values, not raw Roku values.**

## External integrations

- **Waiveo platform API** (`api.registerRoute`, `api.registerModel`, `api.setState`, `api.registerDevicePollAdapter`).
- **device-discovery extension** — required; subscribes to its `discovery:*` events.
- **globalEventBus** — cross-extension events (`state_changed`, `discovery:*`).
- **Roku devices over HTTP/XML** (port 8060 ECP).

## API surface

All routes under `/api/extensions/roku-integration/`:
- `GET /devices`, `GET /devices/:id`, `GET /devices/:id/apps|active-app|info|access`
- `POST /devices/:id/keypress/:key`, `POST /devices/:id/launch/:appId`, `POST /devices/:id/power/on|off`
- `POST /devices/add`, `DELETE /devices/:id`
- `GET|PUT /settings`

## Database

Model: `roku_devices` — device_id, ip_address, name, model, serial_number, software_version, power_mode, status, metadata (JSON), last_seen_at, created_at.

Entity states: `media_player.<device_slug>` with values in `{off, on, playing, idle}` and attrs `power_mode`, `power_state`, `active_app`, `active_app_id`, `app_type`, `is_screensaver`.

## Dependencies

- `xml2js` ^0.6.2 — parse Roku XML responses.

## Common debugging paths

- **Device not appearing** → Check device-discovery logs; confirm SSDP/ECP candidates matched; check `roku_devices` + `device_registry` tables.
- **Automation not firing** → Automation triggers must use `platform: "state"` with `entity_id: "media_player.<slug>"`; custom platforms like `roku-integration.power_changed` are NOT matched.
- **"onStateChange is NULL" warnings** → Cosmetic. The poll adapter's `onStateChange` callback is unused; state flows via `api.setState` → StateManager → eventBus instead.
- **Unexpected entity state values** → Remember the normalization; raw Roku values (`PowerOn`, `Ready`) won't match automation `to:` filters expecting `on` / `playing`.

## Deployment

```bash
cd /Users/matt/waiveo/waiveo && ./scripts/cli/deploy-cli.sh extension roku-integration
```

## Cross-project boundaries

This extension lives in `waiveo/extensions/roku-integration/` (canonical) and is public-mirrored at the workspace root. Changes to the mirror only — canonical builds into the Docker image.
