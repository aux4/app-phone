# aux4/app-phone

Audio calls between aux4 users, with Contacts, Recents, incoming invitations, mute, and persistent call controls. Uses the platform's default SSO. There is no separate Phone login.

Phone is an ordinary platform app and exports the `PhoneCallButton` component. When installed alongside Chat, the conversation header can start or join a call. The global call dock survives navigation between conversations and apps within the same platform page. Reloading or closing the page ends your connection.

## Local development

Requires Node 22+, Docker, aux4/platform, and a configured platform SSO host.

1. Generate a random secret of at least 32 characters and put `PHONE_SERVICE_SECRET=<secret>` in an ignored `.env` file.
2. Run `docker compose up --build -d` from the repository. The signaling service is accessible only on `127.0.0.1:8787`.
3. Set the same `PHONE_SERVICE_SECRET` and `PHONE_SERVICE_URL=http://127.0.0.1:8787` on the platform process; install this package through the normal aux4 package installer.
4. Open `/apps/phone/` on the platform. For an isolated development registry, set `PHONE_CHAT_REGISTRY_HOME` to its directory; otherwise Phone uses the installed registry.

Contacts come from the co-installed Chat directory. Without Chat, users appear after their first authenticated visit to Phone. Both people should open Phone before the first standalone call. Calls and recent history are ephemeral in this local provider, and reset when Docker restarts.

## iPhone and HTTPS

Microphone access requires a trusted HTTPS origin. `tools/local-https.mjs` provides a development gateway in front of the existing SSO platform on port 9100:

```bash
PHONE_PREVIEW_HOST=<your-LAN-IP> node tools/local-https.mjs
```

It requires `mkcert`, serves HTTPS on port 9443, and serves only the public local CA certificate at `http://<your-LAN-IP>:9444/local-ca.crt`. Install that certificate on your test phone and enable its trust in Settings → General → About → Certificate Trust Settings. Keep the private CA key on the development Mac. Configure the platform's registered OAuth callback and post-login URL for your environment; the gateway does not replace SSO or register callback URLs.

## Calls and privacy

Use the phone action beside a contact to call them. Choose Group call to select several people, then press Start call. Contacts and Recents use the shared Form Engine List and its search, including the built-in clear button. Invitees can accept or decline. A channel call invites the current membership; up to eight participants can connect at once. People can join an ongoing call after declining, provided they are still members. On-call indicators disclose only calls visible to you.

All APIs require the host-authenticated principal. Phone resolves channel membership through Chat's membership-only command on every call operation. It looks up the channel from the stored call, never from client authority fields. Removed members lose signaling access; peers remove them on the next poll. Direct calls only accept registered users. No recording or media storage is implemented.

The local provider uses browser-to-browser WebRTC audio for devices on the same LAN. It has no TURN relay, so it is not intended for reliable calls across arbitrary networks. A caller expires after 30 seconds without a heartbeat; invitations expire after 45 seconds. Keep Safari open while testing; background browser execution is subject to iOS suspension.

## Provider contract

`LocalCallProvider.execute(action, input)` owns call membership, invitations and addressed signaling. The platform bridge constructs authenticated inputs; its secret is never sent to browsers. `LocalAudioSession` owns media and exposes `sync`, `receive`, `mute`, `resumeAudio`, and `close`. A future provider package can implement this server/client boundary using Chime or an SFU. No AWS provider is included in this release.

Public actions: `contacts`, `calls`, `start`, `accept`, `decline`, `leave`, `heartbeat`, `poll`, and `signal`. All are under `/api/apps/phone/action/phone/`; contacts/calls are GET and the rest POST. Poll results include recipient-only events and a retry-safe cursor.

## Verification

`npm test` runs authorization and media lifecycle tests. `node test/browser-call.mjs` is the workspace integration test: three Chromium contexts exchange real WebRTC audio RTP from synthetic microphone streams, then exercise mute, navigation and hangup. It uses workspace Browser/Form Engine test dependencies; fixtures are intercepted inside Playwright and are never exposed by the real preview server.
