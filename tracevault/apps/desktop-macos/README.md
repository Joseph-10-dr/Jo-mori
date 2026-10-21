# TraceVault for macOS — not started

**Status: not implemented.** This repository's build environment had no Xcode/Swift toolchain,
so no macOS code has been written or tested. The backend API is ready for a macOS client
(platform value `macos`).

## Plan (Swift)
1. Menu-bar app (always visible) with enrollment (`POST /v1/devices/register`), Keychain storage
   of the device secret, and the same queue/upload/heartbeat behaviour as the Windows agent.
2. Events: login/logout, screen lock/unlock (`NSWorkspace`/distributed notifications), system
   sleep/wake, app launches (`NSWorkspace.didLaunchApplicationNotification`), and — only with the
   user's approval of a System Extension — Endpoint Security events for account and
   security-setting changes.
3. Optional screen recording with **ScreenCaptureKit**, which requires the Screen Recording
   permission and shows the macOS recording indicator; uploads via
   `POST /v1/recordings/upload-url`.
4. Opt-in "Open at Login" with `SMAppService`.

Limits: no keystrokes, no other apps' content, no recording without the TCC permission prompt.
