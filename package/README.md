# aux4/app-phone

Phone is an aux4 platform app for one-to-one and small group audio calls. It does not implement a second login: every action requires the authenticated platform principal. The local provider is intentionally bound to loopback and is reached by the platform command through a shared secret.

## Installation

```bash
aux4 aux4 pkger install aux4/app-phone
```

Run the local provider in Docker with a random `PHONE_SERVICE_SECRET`, then set the same value and `PHONE_SERVICE_URL=http://127.0.0.1:8787` for the platform host. Calls are ephemeral in the local provider and expire after inactivity. A future AWS Chime provider can implement the same action contract without changing the app UI.

## Actions

The app exposes authenticated `calls`, `start`, `accept`, `decline`, `leave`, `heartbeat`, and `signal` actions. A call can target selected aux4 user IDs. Channel calls require a Chat authorization callback and use its current member list, so removed members cannot join.
