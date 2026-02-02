# Roku Integration for Waiveo

Discover and control Roku devices on your network from your Waiveo home automation system.

## Features

- **Auto-Discovery** - Automatically finds Roku devices on your network via port 8060 (Roku ECP)
- **Remote Control** - Full virtual remote with navigation, playback, and volume controls
- **App Launcher** - Browse installed apps and launch them with one click
- **Power Control** - Turn devices on/off and monitor power state
- **Real-time Status** - Live updates for power state, active app, and screensaver detection
- **Automation Triggers** - React to power changes, app launches, screensaver events
- **Multi-device Support** - Manage multiple Roku TVs and streaming devices
- **Device Tagging** - Organize devices with custom tags and filters

## Requirements

- [Waiveo](https://waiveo.com) home automation platform
- `device-discovery` extension (included with Waiveo)
- Roku devices must have "Control by mobile apps" enabled in Settings → System → Advanced system settings

## Installation

### From ZIP Package

1. Download the latest release from [Releases](https://github.com/maaxton/roku-integration/releases)
2. In Waiveo, go to **Extensions** → **Install from ZIP**
3. Upload the downloaded `.zip` file
4. The extension will auto-discover Roku devices on your network

### Manual Installation

1. Clone this repository into your Waiveo extensions directory:
   ```bash
   git clone https://github.com/maaxton/roku-integration.git
   ```
2. Restart Waiveo or reload extensions
3. Enable the extension in **Extensions** settings

## Usage

### Device Control

Navigate to **Roku** in the sidebar to see all discovered devices. Click any device to open the remote control interface with:

- **Remote Tab** - D-pad navigation, playback controls, volume
- **Apps Tab** - Browse and launch installed apps, mark favorites
- **Info Tab** - Device details, network info, capabilities

### Automation

Create automations using Roku triggers:

| Trigger | Description |
|---------|-------------|
| `power_changed` | When power state changes (on/off/playing/idle) |
| `activity_changed` | When activity changes (includes app switches) |
| `app_launched` | When an app starts playing |
| `screensaver_started` | When screensaver activates |
| `screensaver_stopped` | When screensaver deactivates |
| `device_online` | When device comes back online |
| `device_offline` | When device becomes unreachable |

Available actions:

| Action | Description |
|--------|-------------|
| `power_on` | Wake device from standby |
| `power_off` | Put device into standby |
| `launch_app` | Launch a specific app |
| `send_keypress` | Send remote control key |

### Example Automation

Turn off Roku when screensaver has been active for 30 minutes:

```yaml
trigger:
  type: screensaver_started
  device_id: roku:ABC123

condition:
  delay: 30 minutes

action:
  type: power_off
  device_id: roku:ABC123
```

## Roku Device Settings

For full functionality, configure your Roku device:

1. **Settings** → **System** → **Advanced system settings** → **Control by mobile apps**
2. Select **Permissive** for full remote control access
3. Select **Default** for limited access (device info only)

## API Endpoints

The extension provides these API endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/extensions/roku-integration/devices` | List all devices |
| GET | `/api/extensions/roku-integration/devices/:id` | Get device details |
| GET | `/api/extensions/roku-integration/devices/:id/apps` | List installed apps |
| GET | `/api/extensions/roku-integration/devices/:id/active-app` | Get active app |
| POST | `/api/extensions/roku-integration/devices/:id/keypress/:key` | Send keypress |
| POST | `/api/extensions/roku-integration/devices/:id/launch/:appId` | Launch app |
| POST | `/api/extensions/roku-integration/devices/:id/power/on` | Power on |
| POST | `/api/extensions/roku-integration/devices/:id/power/off` | Power off |

## Supported Keys

For `send_keypress` action:

- Navigation: `Home`, `Back`, `Select`, `Up`, `Down`, `Left`, `Right`
- Playback: `Play`, `Pause`, `Rev`, `Fwd`
- Volume: `VolumeUp`, `VolumeDown`, `VolumeMute`
- Power: `PowerOn`, `PowerOff`
- Info: `Info`, `Search`

## Troubleshooting

### Device not discovered

1. Ensure Roku and Waiveo server are on the same network/VLAN
2. Check that port 8060 is not blocked by firewall
3. Verify "Control by mobile apps" is enabled on the Roku

### Commands not working

1. Check mobile control is set to "Permissive" on the Roku
2. Verify device shows as "Online" in Waiveo
3. Check extension logs for errors

### Device shows offline

1. Roku may be in deep sleep - press any button on the physical remote
2. Check network connectivity
3. Try power cycling the Roku device

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please open an issue or pull request.

## Links

- [Waiveo](https://waiveo.com)
- [Roku External Control Protocol (ECP)](https://developer.roku.com/docs/developer-program/debugging/external-control-api.md)
