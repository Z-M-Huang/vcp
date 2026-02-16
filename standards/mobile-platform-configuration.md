---
id: mobile-platform-configuration
title: Mobile Platform Configuration
scope: mobile
severity: high
tags: [mobile, ios, android, ats, permissions, webview, configuration]
references:
  - title: "Apple — App Transport Security"
    url: https://developer.apple.com/documentation/bundleresources/information_property_list/nsapptransportsecurity
  - title: "Android — Network Security Configuration"
    url: https://developer.android.com/privacy-and-security/security-config
  - title: "CWE-250 — Execution with Unnecessary Privileges"
    url: https://cwe.mitre.org/data/definitions/250.html
---

## Principle

Mobile platform configuration is the first layer of defense. A single misconfigured flag in Info.plist or AndroidManifest.xml can silently disable transport security, expose credentials, or grant unnecessary access to device resources. These settings are compiled into the binary and ship to millions of devices — there is no server-side patch for a misconfigured client. Get the platform configuration right before writing a single line of application logic.

## Rules

### iOS Configuration

1. **Do not disable App Transport Security (ATS).** Never set `NSAllowsArbitraryLoads` to `true` in Info.plist. If a specific domain requires HTTP, add a per-domain exception with `NSExceptionDomains` — not a global bypass. Apple rejects apps with unjustified ATS exceptions.

2. **Configure minimal entitlements and Keychain access groups.** Only request entitlements your app actually uses. Scope Keychain access groups to your app's team identifier. Do not use shared access groups unless inter-app credential sharing is explicitly required.

### Android Configuration

3. **Configure Network Security Config for production.** Set `cleartextTrafficPermitted="false"` for the base config. Add certificate pins via `pin-set` with expiration dates. Allow debug-only trust anchors in `<debug-overrides>`, never in the base config.

4. **Request minimum necessary permissions.** Declare only the permissions your app requires. Use runtime permissions (Android 6+) for dangerous permissions. Prefer scoped storage over broad file access (`READ_EXTERNAL_STORAGE`/`WRITE_EXTERNAL_STORAGE`). Prefer `READ_MEDIA_IMAGES` over broad storage access. (CWE-250)

### WebView Configuration

5. **Restrict WebView capabilities.** Disable JavaScript unless explicitly required (`setJavaScriptEnabled(false)` by default). Do not use `addJavascriptInterface` with `targetSdkVersion` < 17 (enables arbitrary code execution). On iOS, prefer `WKWebView` over the deprecated `UIWebView`. Validate the origin of any WebView content — do not load untrusted URLs.

6. **Validate JavaScript bridge communication.** If a native-to-JavaScript bridge is required, validate the origin of messages received from the WebView. Define an allowlist of expected message types. Never execute native operations based on unvalidated WebView messages.

### Cross-Platform

7. **Apply platform-specific security defaults in cross-platform frameworks.** React Native: use `react-native-ssl-pinning` or custom native modules for certificate pinning. Flutter: configure `SecurityContext` for pinning. Expo: ensure `expo-secure-store` is used instead of `AsyncStorage` for secrets. In all frameworks: review the generated native configuration (Info.plist, AndroidManifest.xml) for unintended permissions or security bypasses.

## Patterns

### iOS ATS Configuration

#### Do This

```xml
<!-- Info.plist — per-domain HTTP exception only where required -->
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSExceptionDomains</key>
    <dict>
        <key>legacy-api.internal.example.com</key>
        <dict>
            <key>NSExceptionAllowsInsecureHTTPLoads</key>
            <true/>
            <key>NSExceptionMinimumTLSVersion</key>
            <string>TLSv1.2</string>
        </dict>
    </dict>
</dict>
```

#### Not This

```xml
<!-- Info.plist — global ATS bypass disables transport security for ALL connections -->
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
</dict>
```

**Why it's wrong:** Setting `NSAllowsArbitraryLoads` to `true` disables ATS for every network connection in the app. Any HTTP request — including those carrying auth tokens or user data — is sent in plaintext, vulnerable to interception on any network. Apple will also flag or reject the app during review without a valid justification.

### Android Network Security Config

#### Do This

```xml
<!-- res/xml/network_security_config.xml — restrictive base config -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>

    <domain-config>
        <domain includeSubdomains="true">api.example.com</domain>
        <pin-set expiration="2026-06-01">
            <pin digest="SHA-256">base64EncodedPinHere==</pin>
            <!-- Backup pin — required for rotation -->
            <pin digest="SHA-256">base64EncodedBackupPinHere==</pin>
        </pin-set>
    </domain-config>

    <debug-overrides>
        <trust-anchors>
            <certificates src="user" />
        </trust-anchors>
    </debug-overrides>
</network-security-config>
```

#### Not This

```xml
<!-- res/xml/network_security_config.xml — permits cleartext and trusts user CAs -->
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

**Why it's wrong:** Allowing cleartext traffic means any HTTP connection sends data unencrypted. Trusting user-installed CA certificates in the base config (not just `debug-overrides`) lets anyone with device access install a CA and intercept all HTTPS traffic via a proxy — defeating TLS entirely in production.

### Android Permissions

#### Do This

```xml
<!-- AndroidManifest.xml — minimal, scoped permissions -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
</manifest>
```

```kotlin
// Request dangerous permissions at runtime when the feature is needed
if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
        != PackageManager.PERMISSION_GRANTED) {
    ActivityCompat.requestPermissions(
        this,
        arrayOf(Manifest.permission.CAMERA),
        CAMERA_REQUEST_CODE
    )
}
```

#### Not This

```xml
<!-- AndroidManifest.xml — over-permissioned (CWE-250) -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.READ_CONTACTS" />
    <uses-permission android:name="android.permission.READ_PHONE_STATE" />
</manifest>
```

**Why it's wrong:** Requesting permissions the app does not use violates the principle of least privilege. Users are less likely to install apps that request excessive permissions. If the app is compromised, each unnecessary permission expands the attacker's capabilities — location tracking, microphone recording, contact exfiltration — none of which may be related to the app's function.

### WebView Safe Configuration

#### Do This

```kotlin
// Android — restrictive WebView configuration
val webView = WebView(context)
webView.settings.apply {
    javaScriptEnabled = false // Enable ONLY if JavaScript is required
    allowFileAccess = false
    allowContentAccess = false
    domStorageEnabled = false
}

// If JavaScript must be enabled, restrict to trusted origins
webView.webViewClient = object : WebViewClient() {
    override fun shouldOverrideUrlLoading(
        view: WebView?,
        request: WebResourceRequest?
    ): Boolean {
        val host = request?.url?.host ?: return true
        val allowedHosts = setOf("app.example.com", "cdn.example.com")
        return host !in allowedHosts // Block navigation to untrusted origins
    }
}
```

```swift
// iOS — WKWebView with restricted configuration
import WebKit

let config = WKWebViewConfiguration()
let preferences = WKWebpagePreferences()
preferences.allowsContentJavaScript = false // Enable ONLY if required

let webView = WKWebView(frame: .zero, configuration: config)
webView.configuration.defaultWebpagePreferences = preferences

// Validate navigation targets
class NavigationDelegate: NSObject, WKNavigationDelegate {
    private let allowedHosts: Set<String> = [
        "app.example.com",
        "cdn.example.com"
    ]

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let host = navigationAction.request.url?.host,
              allowedHosts.contains(host) else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}
```

#### Not This

```kotlin
// Android — unrestricted WebView (dangerous)
val webView = WebView(context)
webView.settings.javaScriptEnabled = true
webView.settings.allowFileAccess = true
webView.addJavascriptInterface(BridgeObject(), "NativeBridge")
webView.loadUrl(intentUri) // Loading unvalidated URL from intent
```

**Why it's wrong:** Enabling JavaScript, file access, and a JavaScript interface together allows any page loaded in the WebView to call native methods, read local files, and execute arbitrary code. Loading a URL from an unvalidated intent means an attacker can craft an intent that navigates the WebView to a malicious page, which then calls `NativeBridge` methods to access native device capabilities.

## Exceptions

- **Development builds** may include debug trust anchors for local HTTPS proxies (e.g., Charles, mitmproxy). These must be in `<debug-overrides>` on Android or conditionally applied in debug schemes only — never in the release configuration.
- **Apps communicating with legacy internal services** may need per-domain HTTP exceptions in ATS (`NSExceptionDomains`) or Android Network Security Config (`domain-config` with `cleartextTrafficPermitted="true"`). Document why the exception exists, limit it to the specific domain, and track a remediation plan to migrate the service to HTTPS.

## Cross-References

- [Mobile Security](mobile-security) — Credential storage, certificate pinning, deep links
- [Security](core-security) — Principle of least privilege, input validation, secrets management
