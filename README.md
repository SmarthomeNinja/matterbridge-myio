# matterbridge-myio

A [Matterbridge](https://matterbridge.io) plugin for **myIO smart home controllers**. It exposes the outputs, shutters,
thermostat zones and sensors of one or more myIO controllers as Matter devices, so they appear in Google Home, Amazon
Alexa, Home Assistant, Apple Home, SmartThings and any other Matter controller, next to your other devices.

- **No firmware change, no cloud.** The plugin talks to the controller over its local HTTP API with the user you give it.
- **Two-way.** What you switch on a wall button, a timer or the myIO app shows up in the Matter apps within about a second.
- **Several controllers on one bridge.** Pair the bridge once; all devices arrive with it.
- **You choose what is exposed**: by the permissions of the myIO user, and by a white / black list.

> **Status: beta.** Tested with Matterbridge 3.11, paired with **Google Home**, **Amazon Alexa** and
> **Home Assistant** at the same time. Apple Home and SmartThings are supported by Matterbridge but have not been tried
> by us yet. Feedback is welcome: info@myio.hu

## What appears in Matter

| myIO element | Matter device | Notes |
|---|---|---|
| relay, switch-mode output | outlet or light | light if the name contains a light keyword (lámpa, világítás, fény, spot, light, lamp, led …) |
| PWM output (dimmer) | dimmable light | the slider covers the MIN…MAX range of the output; switching on returns to the last level |
| protection pair (UP / DOWN outputs) | window covering | open / close / stop / percentage; the position is estimated from the travel time |
| output switched by a temperature sensor | thermostat | heating or cooling; the target is the middle of the ON / OFF thresholds, the band is kept |
| group named `RGB…` with R / G / B dimmer members | colour light | colour, brightness, on / off; remembers the colour while off |
| temperature and humidity sensors | temperature / humidity sensor | |
| universal sensors (firmware 4.x) | temperature, humidity, illuminance, pressure | by sensor type; needs a user with editor level |
| group (other than RGB) | switch | only on request (`exposeGroups`) |

Outputs appear only if they have a **name** on the controller (change with `exposeUnnamed`). The parts of a composite
device (the two relays of a shutter, the three channels of an RGB light, the output of a thermostat) are not exposed
separately. Inputs (wall buttons), mixing-valve outputs, energy meters and scenes are not exposed in this version.

## Requirements

- A myIO controller on the local network: **myIO Server V4** (GIGA or Opta, firmware 4.x) or **V3** (firmware 3.12 or
  newer).
- **Matterbridge 3.11 or newer** on a machine that is always on and sits on the same network as the controller and
  your Matter hubs: a Raspberry Pi, a NAS, a mini PC, a Mac, or the Matterbridge add-on of Home Assistant OS.
  See the [Matterbridge documentation](https://matterbridge.io) for installation (Docker, Linux service, macOS, Windows).
- Matter needs **IPv6 and mDNS on the LAN** (the internet side does not matter). VLANs, guest networks and client
  isolation between the bridge and the hubs / phones break pairing.
- For Google Home, Alexa and Apple Home: a Matter hub of that ecosystem (a Nest or Google TV device, an Echo, a HomePod
  or Apple TV).

## Installation

In the Matterbridge frontend (`http://<address of the bridge machine>:8283`), on the Home page type
`matterbridge-myio` into the **Install plugins** field, press **Install**, then restart Matterbridge (the circular arrow
in the header).

From a terminal:

```sh
npm install -g matterbridge-myio --omit=dev
matterbridge --add matterbridge-myio
```

## Configuration

Open the plugin configuration (the gear icon in the row of the plugin) and add your controller under **Controllers**:

| Field | Meaning |
|---|---|
| Name | a label of your choice (e.g. `Ground floor`); used in the logs and to tell apart equal names on two controllers |
| Address | IP address or host name of the controller (e.g. `192.168.1.170`; add `:port` if it is not 80) |
| Username / Password | a user of the controller |

Press **Confirm**, then restart Matterbridge. The devices appear on the Devices page of the frontend.

**Choosing what is exposed.** The plugin sees exactly what its myIO user sees, and can switch only what that user may
switch. The cleanest setup is a dedicated user on the controller (e.g. `matter`) with rights only for the elements
you want in Matter. On top of that, the **White List** and **Black List** in the plugin configuration select devices
by name.

All settings:

| Key | Default | Meaning |
|---|---|---|
| `controllers` | `[]` | the controllers: `name`, `host`, `username`, `password` |
| `pollInterval` | `1000` | how often the state is read (ms); a V3 is never polled faster than every 2000 ms |
| `rediscoverInterval` | `600` | how often names and the list of elements are read again (s): new, renamed and removed elements follow within this time, without a restart |
| `exposeUnnamed` | `false` | also expose outputs that have no name (`Relay 7`) |
| `relayType` | `outlet` | device type of on / off outputs without a light keyword: `outlet` or `light` |
| `lightKeywords` | lampa, vilagitas, csillar, spot, feny, light, lamp, led | an on / off output whose name contains one of these appears as a light (case and accents are ignored) |
| `exposeShutters` | `true` | protection pairs as window coverings |
| `shutterTravelTime` | `30` | time of a full run of the shutters (s) |
| `shutterTravelTimes` | `[]` | a different travel time per shutter: `{ "name": "Living room shutter", "seconds": 22 }` |
| `exposeThermostats`, `exposeRgb`, `exposeSensors` | `true` | switch a kind of device on or off |
| `exposeGroups` | `false` | named groups as switches |
| `whiteList`, `blackList` | `[]` | filter by device name (selectable from a list in the frontend) |
| `debug` | `false` | log every command sent to the controller and every attribute update |

Tip: Matterbridge adds two switches of its own, *Restart Matterbridge* and *Update Matterbridge*, which show up as
devices in every ecosystem. To hide them, set **Virtual devices** to *Disabled* on the Settings page of the frontend.

## Pairing

The bridge is paired once, like a single Matter device, with the QR code or the manual code on the Home page of the
frontend. It can be paired with **several ecosystems at the same time**: after the first pairing press
**Turn on pairing** in the *Paired fabrics* panel, and the same code works again for about 15 minutes. (Sharing the
bridge from the app it is already paired with works too.)

Matterbridge is open-source software and uses the Matter test vendor ID; it is not a certified Matter product. What
that means in each ecosystem:

- **Home Assistant** – Settings → Devices & services → Add device → Matter. Accepts the bridge as it is.
- **Google Home** – only accepts an uncertified bridge if the Google account used for pairing has a project in the
  [Google Home Developer Console](https://console.home.google.com/projects) with a Matter integration for
  **Vendor ID `0xFFF1`, Product ID `0x8000`** (the Matterbridge defaults). Create it once, restart your Google hub,
  then add the bridge in the app: Devices → Add → Matter-enabled device. The Matterbridge documentation mentions a
  "Something went wrong" error when pairing from Android; we did not meet it, and pairing from an iPhone is the
  known workaround.
- **Amazon Alexa** – Devices → + → Add Device → Other → Matter, then the QR or the numeric code. An Echo on the same
  network does the pairing, and it needs **current firmware**: an Echo Dot (2nd generation) of ours did not look for
  the bridge at all until it was updated ("Alexa, check for software updates"); the app only said it could not find
  the device. Alexa handles **at most 50 bridged devices** per bridge (use the lists to stay below), shows the
  shutter percentage **inverted** and does not know the pressure sensor.
- **Apple Home** – shows an "uncertified accessory" warning and lets you continue. Not tried by us yet.

If the phone does not find the bridge: check that phone, hub and bridge are on the same network; allow incoming
connections for `node` in the firewall of the bridge machine (Matter uses UDP 5540 and mDNS on UDP 5353); and if the
machine has more than one network interface (VPN, Docker), enter the name of the LAN interface under **Mdns interface**
on the Settings page of the frontend.

## How it behaves

- **State.** The controller is polled once a second; a change made on a wall button, by a timer or in the myIO app
  appears with that delay. If the controller did not carry out a command (no write permission, an active
  protection), the device falls back to its real state after 2.5 seconds.
- **Errors.** If a command cannot reach the controller, the Matter command fails and the app shows it. After two
  failed polls the devices of that controller are marked unreachable; they recover on their own.
- **Restarts.** Device identity comes from the serial number of the controller and the element ID, so renaming the
  controller or changing its IP address does not create new devices. If the bridge starts while the controller is
  down, the last known device list is restored (as unreachable), so the ecosystems keep the devices and their rooms.
- **Shutters.** myIO has no position feedback, so the bridge integrates the running time with the travel time you
  set (movements started from a wall button are followed too). At the end positions the motor is stopped by the
  timer of the controller or by the limit switch, not by the bridge; a timed stop is used only for targets in
  between (e.g. 30 %). The estimate can drift, and every full run synchronises it again. When the direction is
  reversed while moving, the bridge stops first and waits 0.6 s.
- **Thermostats.** The control loop runs in the controller and a zone has no "off" mode: an "off" set in an app is
  reverted. Set a low target instead. Changing the target rewrites the two thresholds of the output.
- **Dimmers.** "On" returns to the last brightness (the controller itself would jump to the maximum).
- **Names.** Matter names are at most 32 characters. If two elements of a controller share a name, the later one
  gets its myIO ID appended (`Mood light 2008`); if the name clashes with a device of another controller, the name
  of the controller is appended (`Lamp (Upstairs)`).

## Troubleshooting

- **"not reachable" in the log, devices shown as offline** – check the address, the user and the password. After
  several wrong passwords the controller locks out the address of the bridge for a while, so the plugin retries a
  failed login only once a minute.
- **A device is missing** – it has no name on the controller, the myIO user has no permission for it, it is part of
  a shutter / RGB light / thermostat, or it is filtered by a list. New and renamed elements follow within the
  rediscover interval (10 minutes by default) or after a restart of the plugin.
- **A relay appears as an outlet instead of a light** – put a light keyword into its name, extend `lightKeywords`,
  or set `relayType` to `light`.
- **Universal sensors are missing** – they need a myIO user with editor level; the log says so.
- **Alexa does not find the bridge** – update the Echo, and turn pairing on again in the frontend.

## Licence

Apache-2.0. Copyright 2026 myIO Smart Home Zrt.

myIO is a product of [myIO Smart Home Zrt.](https://myio.hu) Matter is a trademark of the Connectivity Standards
Alliance. Neither Matterbridge nor this plugin is a certified Matter product. Google Home, Amazon Alexa, Apple Home
and SmartThings are trademarks of their respective owners.
