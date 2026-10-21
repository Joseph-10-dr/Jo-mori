# TraceVault for Android — not started

**Status: not implemented.** No Android SDK was available in the build environment. The API
supports platform `android`.

## Plan (Kotlin)
1. Enrollment with a one-time code; device secret in the Android Keystore; WorkManager for
   periodic upload (respecting Doze/background limits) and FCM for push alerts.
2. Events Android actually exposes to a normal app: screen on/off and user present
   (`ACTION_USER_PRESENT`), boot completed, the app's own permission changes, and — for
   company devices enrolled as Device Owner/Profile Owner — `DeviceAdminReceiver` failed-password
   and security-log events.
3. Optional screen recording only through **MediaProjection**, which shows the system consent
   dialog every session and a persistent notification; microphone via `RECORD_AUDIO` runtime
   permission and a foreground service with a visible notification.

Limits: Android does not let ordinary apps see other apps' activity or read system logs; usage
access (`PACKAGE_USAGE_STATS`) would need explicit user opt-in and is not planned for the MVP.
