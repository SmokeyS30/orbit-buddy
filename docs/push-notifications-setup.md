# Native iOS push notifications — owner setup

The code is done and deployed. Three things remain, all in your lane:

## 1. Apple Developer portal — create the APNs key (one time)

1. Go to [developer.apple.com](https://developer.apple.com) → **Certificates, Identifiers & Profiles** → **Keys** → **+**.
2. Name it `Orbit Buddy APNs`, check **Apple Push Notifications service (APNs)**, click **Continue** → **Register**.
3. **Download the `.p8` file now** — Apple shows it once, then it's gone. Save it somewhere safe (password manager, not the repo).
4. On the key's detail page, copy the **Key ID** (10 characters, e.g. `AB12CD34EF`).
5. Go to **Membership details** and copy your **Team ID**.

## 2. Xcode — enable the Push Notifications capability

1. Open `ios/App/App.xcodeproj`, select the **App** target → **Signing & Capabilities**.
2. Click **+ Capability** → add **Push Notifications**.
3. Rebuild / re-archive after this — the entitlement must be in the binary.

## 3. Azure portal — set the env vars

In the orbit-buddy Container App → **Environment variables**, add:

| Name | Value |
|---|---|
| `APNS_KEY_P8` | The **entire contents** of the `.p8` file, including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines. Paste with real line breaks; `\n`-escaped text also works. |
| `APNS_KEY_ID` | The Key ID from step 1 (e.g. `AB12CD34EF`). |
| `APNS_TEAM_ID` | Your Apple Developer Team ID. |
| `APNS_BUNDLE_ID` | Optional — defaults to `com.smokeys30.orbitbuddy`. Only set if your bundle ID differs. |

Then **restart** the container app revision so the new vars take effect.

## How it behaves

- **Server without these vars**: starts fine, logs `[apns] APNs not configured` once, native pushes are skipped. Nothing crashes.
- **iPhone**: open Orbit → Settings → the push button now says **Enable on this device** (previously "Not supported on this device"). Tap it → iOS asks for notification permission → the app registers with APNs and uploads its device token automatically.
- **First live use**: the door-left-open nudge ("Registration still open") now also pushes to your iPhone via APNs, alongside the existing web push.
- **Dead tokens**: if Apple reports a token as unregistered (410), the server deletes it automatically.

## End-to-end test

1. Set the env vars + restart Azure.
2. Install a TestFlight build that includes the Push capability (step 2).
3. In the app: Settings → Enable on this device → allow notifications.
4. Trigger the nudge: open the registration door (Safety tab) and leave it open for over an hour — or ask Orbit to simulate it. Your iPhone should get the push.
