# TraceVault for iOS — not started

**Status: not implemented.** No Xcode toolchain was available. The API supports platform `ios`.

## Plan (Swift)
1. Enrollment, Keychain-stored device secret, APNs push for alerts, and a dashboard view of the
   user's other devices (the main iOS value is *reviewing* history and receiving alerts).
2. iOS gives third-party apps no system event log and no visibility into other apps, and
   background execution is tightly limited. Only app-level events (enrollment, app opened,
   notification permission changes) can be recorded.
3. Optional screen recording only through **ReplayKit** broadcast extensions, started by the
   user from the system picker, with the system's red recording indicator. Background or
   unattended recording is not possible and will not be offered.
