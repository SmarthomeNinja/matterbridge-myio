# Changelog

## 0.1.4 (2026-11-17)

Package metadata only. No change in behaviour.

- links to the source code on GitHub and to its issue tracker
- the homepage is the setup guide on myio.hu (https://myio.hu/en/guides/matter)

## 0.1.3 (2026-11-13)

Documentation only. No change in behaviour.

## 0.1.2 (2026-11-13)

First release on npm. No change in behaviour.

- tested on a real controller, paired with Google Home, Amazon Alexa and Home Assistant at the same time
- English README for users, licence file, package metadata

## 0.1.1 (2026-11-12)

First run on a real controller (75 devices), paired with Google Home and Amazon Alexa at the same time.

- same name twice on one controller: the later element gets its myIO id ("hangulat fény 2008") instead of a bare " 2"; a clash with another controller gets that controller's name ("Lámpa (Emelet)")
- the controller password is masked in the Matterbridge configuration dialog
- bench script: `--mdns <interface>` pins the Matter mDNS advertisement to the LAN interface (needed next to VPN tunnels), remembered between starts
- `scripts/mdns-watch.mjs`: passive listener that shows who is looking for Matter devices on the LAN (pairing diagnostics)
- bench script: Matterbridge's own "Restart / Update Matterbridge" virtual switches are off (`--novirtual`), they showed up as devices in every ecosystem
- bench script: a stop signal or a closed terminal no longer cuts the shutdown short (a running timed shutter move is stopped, the Matter sessions are closed)

## 0.1.0 (2026-11-11)

First version (MATTER_PLAN.md, option A).

- myIO controllers (GIGA / Opta 4.x, Due 3.12) bridged over their HTTP API, no firmware change: `/sens_out.json` poll, commands in `POST /info.json`
- relays and switch-mode PCA channels as outlets or lights (by name keyword), PWM PCA / FET channels as dimmable lights scaled to the MIN..MAX range of the output
- protection pairs as window coverings with a position estimated from the travel time
- sensor-controlled outputs as thermostats (heating or cooling), RGB groups as colour lights
- temperature / humidity sensors, universal sensors (temperature, humidity, dew point, illuminance, pressure)
- several controllers, names unique across the bridge, white / black list, selection by controller permissions
- rediscovery without restart (new, renamed, removed elements), reachability, device list cached for a start while the controller is down
- unit tests and an end-to-end test with a real Matterbridge and a matter.js controller against a mock controller
