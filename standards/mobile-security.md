---
id: mobile-security
title: Mobile Security
scope: mobile
severity: critical
tags: [security, mobile, keychain, keystore, certificate-pinning, deep-links, biometrics, owasp, app-attestation, binary-protection, privacy, backup, owasp-m6, owasp-m7]
references:
  - title: "OWASP Mobile Application Security Verification Standard (MASVS)"
    url: https://mas.owasp.org/MASVS/
  - title: "OWASP Mobile Top 10 (2024)"
    url: https://owasp.org/www-project-mobile-top-10/
  - title: "CWE-312 — Cleartext Storage of Sensitive Information"
    url: https://cwe.mitre.org/data/definitions/312.html
  - title: "CWE-295 — Improper Certificate Validation"
    url: https://cwe.mitre.org/data/definitions/295.html
  - title: "OWASP Mobile Top 10:2024 M6 — Inadequate Privacy Controls"
    url: https://owasp.org/www-project-mobile-top-10/
  - title: "OWASP Mobile Top 10:2024 M7 — Insufficient Binary Protections"
    url: https://owasp.org/www-project-mobile-top-10/
  - title: "Apple — App Attest"
    url: https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity
  - title: "Google — Play Integrity API"
    url: https://developer.android.com/google/play/integrity
---

## Principle

Mobile apps run on devices you do not control. The binary is decompilable, the filesystem is accessible on rooted/jailbroken devices, and the network is hostile. Every secret embedded in the app is public. Every deep link parameter is attacker-controlled input. Every boolean check is bypassable with runtime hooking. Security on mobile means using platform-provided cryptographic primitives — Keychain, Keystore, CryptoObject, certificate pinning — not trusting the device to protect plaintext.

## Rules

### Credential Storage

1. **Store credentials in platform secure storage only.** iOS: Keychain Services. Android: EncryptedSharedPreferences or Android Keystore. Never store tokens, passwords, or API keys in SharedPreferences, UserDefaults, localStorage, AsyncStorage, or plain files. Mobile apps are decompilable — everything in the binary is accessible. (CWE-312)

### Network Security

2. **Implement certificate pinning with public key pins.** Pin the public key (SPKI hash), not the certificate — certificates rotate, keys typically don't. iOS: use URLSession's `didReceive challenge` delegate. Android: use Network Security Config with `pin-sha256`. React Native: use libraries that support native pinning. Always include a backup pin for rotation. (CWE-295)

3. **Enforce TLS and validate server identity.** All network traffic must use TLS 1.2+. iOS: do not disable App Transport Security (ATS). Android: set `cleartextTrafficPermitted="false"` in Network Security Config. Never accept self-signed certificates in production.

### Deep Links and IPC

4. **Validate deep links and universal links.** Configure universal links (iOS) and app links (Android) with verified domain association (`apple-app-site-association`, `assetlinks.json`). Validate all parameters received through deep links — they are attacker-controlled input. Never auto-navigate to arbitrary URLs from deep links. Never pass authentication tokens via deep link parameters.

5. **Secure IPC and exported components.** Android: set `exported="false"` on Activities, Services, BroadcastReceivers, and ContentProviders that should not be accessible to other apps. Use signature-level permissions for inter-app communication. Validate all data received via Intents. iOS: validate URL scheme callbacks.

### Authentication

6. **Use cryptographic binding for biometric authentication.** Biometric auth must be backed by a cryptographic operation, not a boolean "is authenticated" callback. iOS: bind to Keychain item with `.biometryCurrentSet`. Android: use `CryptoObject` with `BiometricPrompt`. A boolean check is trivially bypassed with runtime hooking tools (Frida, Objection).

### Data Protection

7. **Prevent background data exposure.** iOS takes a screenshot when the app goes to background (visible in app switcher). Implement `applicationWillResignActive` to hide sensitive content. Clear clipboard of sensitive data. Disable keyboard caching for sensitive inputs. Never log sensitive data (tokens, PII) — logs are readable on rooted/jailbroken devices.

8. **Never embed secrets in the app bundle.** Mobile binaries (APK, IPA) are trivially decompilable. API keys, signing secrets, and encryption keys in the binary are public. Use server-side key exchange, app attestation (Play Integrity, DeviceCheck), or sealed secrets that require a valid session.

### Platform Integrity

9. **Implement app attestation for API requests (OWASP M3).** Use App Attest (iOS) and Play Integrity (Android) to verify API requests come from a legitimate, unmodified app on a genuine device. This prevents API abuse from modified APKs, emulators, and automation tools. iOS: use `DCAppAttestService` to generate attestation keys, attest them with Apple, and generate assertions for each API request — the server verifies the assertion against Apple's attestation servers. Android: use Play Integrity API to get integrity verdicts — the server verifies the verdict token to confirm app integrity, device integrity, and license status.

10. **Apply binary protections for release builds (OWASP M7, MASVS-RESILIENCE).** Apply code obfuscation, anti-tampering, and anti-debugging for release builds. iOS: strip symbols, enable Position Independent Executable (PIE). Android: enable R8/ProGuard with shrinking and obfuscation, use Play Integrity for root detection. Do not rely solely on these — they raise the bar but are not absolute defenses.

11. **Exclude sensitive data from backups and cloud sync (OWASP M9).** Exclude sensitive data from iCloud, Google backups, and cloud sync. iOS: use `NSFileProtectionComplete`, set `isExcludedFromBackup` on sensitive files. Android: set `android:allowBackup="false"` in manifest or use `android:fullBackupContent` to exclude sensitive directories. Keychain items should use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (not synced to iCloud Keychain).

12. **Implement privacy controls and data minimization (OWASP M6).** Implement App Tracking Transparency (ATT) on iOS before tracking. Maintain accurate privacy labels (iOS Privacy Nutrition Labels, Android Data Safety Section). Minimize data collection — only collect what is necessary for the feature. Purpose-limit collected data — do not repurpose location data collected for navigation into analytics without consent.

## Patterns

### Keychain Storage (iOS)

#### Do This

```swift
import Security

// Store token in Keychain — encrypted by the Secure Enclave
func saveToken(_ token: String, forAccount account: String) throws {
    let data = Data(token.utf8)
    let query: [String: Any] = [
        kSecClass as String:       kSecClassGenericPassword,
        kSecAttrAccount as String: account,
        kSecValueData as String:   data,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    ]

    // Delete any existing item first
    SecItemDelete(query as CFDictionary)

    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
        throw KeychainError.saveFailed(status)
    }
}

func loadToken(forAccount account: String) throws -> String? {
    let query: [String: Any] = [
        kSecClass as String:       kSecClassGenericPassword,
        kSecAttrAccount as String: account,
        kSecReturnData as String:  true,
        kSecMatchLimit as String:  kSecMatchLimitOne
    ]

    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)

    guard status == errSecSuccess, let data = result as? Data else {
        return nil
    }
    return String(data: data, encoding: .utf8)
}
```

#### Not This

```swift
// Storing token in UserDefaults — plaintext, trivially readable (CWE-312)
UserDefaults.standard.set(authToken, forKey: "auth_token")
let token = UserDefaults.standard.string(forKey: "auth_token")
```

**Why it's wrong:** UserDefaults is stored as a plaintext plist file in the app sandbox. On jailbroken devices, any app or tool can read it. On non-jailbroken devices, iTunes backups (unencrypted by default) expose it. Keychain data is encrypted by the Secure Enclave and not included in unencrypted backups.

### EncryptedSharedPreferences (Android)

#### Do This

```kotlin
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

// Store token with encryption backed by Android Keystore
fun saveToken(context: Context, token: String) {
    val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    val prefs = EncryptedSharedPreferences.create(
        context,
        "secure_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    prefs.edit().putString("auth_token", token).apply()
}

fun loadToken(context: Context): String? {
    val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    val prefs = EncryptedSharedPreferences.create(
        context,
        "secure_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    return prefs.getString("auth_token", null)
}
```

#### Not This

```kotlin
// Storing token in plain SharedPreferences — readable on rooted devices (CWE-312)
val prefs = context.getSharedPreferences("app_prefs", Context.MODE_PRIVATE)
prefs.edit().putString("auth_token", token).apply()
```

**Why it's wrong:** SharedPreferences writes an unencrypted XML file to the app's data directory. On rooted devices, `su` grants direct filesystem access. Backup extraction, `adb backup`, and forensic tools all expose plaintext SharedPreferences. EncryptedSharedPreferences uses AES-256-GCM keys stored in the hardware-backed Android Keystore.

### Deep Link Parameter Validation

#### Do This

```swift
// Validate deep link parameters — treat as untrusted input
func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
) -> Bool {
    guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
          let url = userActivity.webpageURL,
          let components = URLComponents(url: url, resolvingAgainstBaseURL: true) else {
        return false
    }

    // Allowlist of valid paths — never navigate to arbitrary URLs
    let allowedPaths = ["/product", "/category", "/profile"]
    guard allowedPaths.contains(components.path) else {
        return false
    }

    // Validate and sanitize individual parameters
    if let productId = components.queryItems?.first(where: { $0.name == "id" })?.value {
        guard productId.allSatisfy(\.isNumber), productId.count <= 10 else {
            return false
        }
        navigateToProduct(id: productId)
    }

    return true
}
```

```kotlin
// Android: validate intent data from app links
override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val uri = intent.data ?: return

    // Verify the host matches your domain
    if (uri.host != "app.example.com") return

    // Allowlist valid paths
    val allowedPaths = listOf("/product", "/category", "/profile")
    if (uri.path !in allowedPaths) return

    // Validate parameters
    val productId = uri.getQueryParameter("id") ?: return
    if (!productId.all { it.isDigit() } || productId.length > 10) return

    navigateToProduct(productId)
}
```

#### Not This

```swift
// Navigating to arbitrary URLs from deep link — open redirect (CWE-601)
func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any]) -> Bool {
    if let target = url.queryParameters?["redirect"] {
        // VULNERABLE: attacker controls the redirect destination
        navigateTo(urlString: target)
    }
    return true
}
```

**Why it's wrong:** Deep link parameters are attacker-controlled. A malicious link like `yourapp://open?redirect=https://evil.com/phishing` navigates the user to a phishing page from within your app, lending credibility to the attack. Always use an allowlist of valid destinations and validate all parameters.

### Biometric Auth with Cryptographic Binding

#### Do This

```kotlin
import androidx.biometric.BiometricPrompt
import javax.crypto.Cipher

// Biometric auth backed by a cryptographic operation
fun authenticateWithBiometrics(activity: FragmentActivity) {
    // Key is bound to biometric enrollment — invalidated if biometrics change
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val key = keyStore.getKey("biometric_key", null) as SecretKey

    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key)

    // CryptoObject ties the biometric check to a real cryptographic operation
    val cryptoObject = BiometricPrompt.CryptoObject(cipher)

    val prompt = BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                // The cipher inside result.cryptoObject is now unlocked
                val authenticatedCipher = result.cryptoObject?.cipher
                    ?: return
                // Use the cipher to decrypt the stored token
                val token = decryptToken(authenticatedCipher)
                proceedWithToken(token)
            }
        }
    )

    val promptInfo = BiometricPrompt.PromptInfo.Builder()
        .setTitle("Authenticate")
        .setNegativeButtonText("Cancel")
        .build()

    prompt.authenticate(promptInfo, cryptoObject)
}
```

```swift
import LocalAuthentication
import Security

// iOS: Bind biometric auth to a Keychain item with access control
func loadTokenWithBiometrics(completion: @escaping (String?) -> Void) {
    let accessControl = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        .biometryCurrentSet,  // Invalidated if biometrics change
        nil
    )

    let context = LAContext()
    context.localizedReason = "Authenticate to access your account"

    let query: [String: Any] = [
        kSecClass as String:          kSecClassGenericPassword,
        kSecAttrAccount as String:    "auth_token",
        kSecReturnData as String:     true,
        kSecMatchLimit as String:     kSecMatchLimitOne,
        kSecUseAuthenticationContext as String: context,
        kSecAttrAccessControl as String: accessControl as Any
    ]

    DispatchQueue.global().async {
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data {
            completion(String(data: data, encoding: .utf8))
        } else {
            completion(nil)
        }
    }
}
```

#### Not This

```kotlin
// Boolean-only biometric check — trivially bypassed with Frida/Objection
fun authenticateWithBiometrics(activity: FragmentActivity) {
    val prompt = BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                // No CryptoObject — this is just a boolean gate
                isAuthenticated = true
                showSecureContent()
            }
        }
    )

    val promptInfo = BiometricPrompt.PromptInfo.Builder()
        .setTitle("Authenticate")
        .setNegativeButtonText("Cancel")
        .build()

    // No CryptoObject passed — biometric is decorative, not cryptographic
    prompt.authenticate(promptInfo)
}
```

**Why it's wrong:** Without a `CryptoObject`, the biometric check is a boolean gate. An attacker using Frida or Objection can hook `onAuthenticationSucceeded` and call it directly, bypassing biometrics entirely. With `CryptoObject`, the key material is only released by the Secure Element after biometric verification — there is nothing to hook because the cryptographic operation physically cannot proceed without the biometric.

### Network Security Config (Android)

#### Do This

```xml
<!-- res/xml/network_security_config.xml -->
<network-security-config>
    <!-- Block all cleartext (HTTP) traffic -->
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>

    <!-- Certificate pinning for your API domain -->
    <domain-config>
        <domain includeSubdomains="true">api.example.com</domain>
        <pin-set expiration="2026-06-01">
            <!-- Primary pin (current key) -->
            <pin digest="SHA-256">AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=</pin>
            <!-- Backup pin (next key for rotation) -->
            <pin digest="SHA-256">BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=</pin>
        </pin-set>
    </domain-config>
</network-security-config>
```

#### Not This

```xml
<!-- Disabling all security checks — accepts any certificate (CWE-295) -->
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

**Why it's wrong:** Allowing cleartext traffic enables passive eavesdropping. Trusting user-installed certificates means any proxy tool (Charles, mitmproxy) or enterprise MDM certificate can intercept all traffic. The production config must only trust system certificates and pin your API server's public key.

### Exported Components (Android)

#### Do This

```xml
<!-- AndroidManifest.xml — only export what must be externally accessible -->
<activity
    android:name=".LoginActivity"
    android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>
</activity>

<!-- Internal activity — not accessible to other apps -->
<activity
    android:name=".AdminActivity"
    android:exported="false" />

<receiver
    android:name=".InternalReceiver"
    android:exported="false" />

<provider
    android:name=".InternalProvider"
    android:exported="false"
    android:authorities="com.example.app.provider" />
```

#### Not This

```xml
<!-- All components exported by default — any app can start your activities -->
<activity
    android:name=".AdminActivity"
    android:exported="true" />

<receiver
    android:name=".PaymentReceiver"
    android:exported="true" />
```

**Why it's wrong:** Exported components are accessible to any app on the device. A malicious app can start your AdminActivity directly (bypassing login), send crafted broadcasts to your PaymentReceiver, or query your ContentProvider for user data. Set `exported="false"` on everything that is not explicitly designed for inter-app access.

### App Attestation (iOS)

#### Do This

```swift
import DeviceCheck

// Generate and attest a key, then create assertions for API requests
class AttestationService {
    private let service = DCAppAttestService.shared

    func generateAttestationKey() async throws -> String {
        guard service.isSupported else {
            throw AttestationError.notSupported
        }
        return try await service.generateKey()
    }

    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data {
        return try await service.attestKey(keyId, clientDataHash: clientDataHash)
    }

    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data {
        return try await service.generateAssertion(keyId, clientDataHash: clientDataHash)
    }

    // Attach assertion to API request
    func makeAttestedRequest(url: URL, body: Data, keyId: String) async throws -> URLRequest {
        let hash = SHA256.hash(data: body)
        let clientDataHash = Data(hash)
        let assertion = try await generateAssertion(keyId, clientDataHash: clientDataHash)

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue(assertion.base64EncodedString(), forHTTPHeaderField: "X-Apple-Assertion")
        return request
    }
}
```

#### Not This

```swift
// Trusting a client-reported app version or simple API key
var request = URLRequest(url: apiURL)
request.setValue("my-secret-api-key-12345", forHTTPHeaderField: "X-API-Key")
request.setValue(Bundle.main.infoDictionary?["CFBundleVersion"] as? String, forHTTPHeaderField: "X-App-Version")
// Anyone with the API key can call your endpoints — modified APK, script, curl
```

**Why it's wrong:** API keys embedded in the binary are trivially extractable. Client-reported version headers can be spoofed by any HTTP client. App attestation cryptographically proves the request originates from a genuine, unmodified app on a real device — the server verifies the assertion against Apple/Google, not the client's self-reported identity.

### App Attestation (Android)

#### Do This

```kotlin
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest

// Request Play Integrity token and send to server for verification
class PlayIntegrityService(private val context: Context) {

    suspend fun getIntegrityToken(requestHash: String): String {
        val integrityManager = IntegrityManagerFactory.create(context)

        val request = IntegrityTokenRequest.builder()
            .setCloudProjectNumber(CLOUD_PROJECT_NUMBER)
            .setRequestHash(requestHash) // Hash of the request body for binding
            .build()

        val response = integrityManager.requestIntegrityToken(request).await()
        return response.token()
    }

    // Attach integrity token to API request
    suspend fun makeAttestedRequest(url: String, body: String): Request {
        val requestHash = body.toByteArray().sha256().base64()
        val integrityToken = getIntegrityToken(requestHash)

        return Request.Builder()
            .url(url)
            .post(body.toRequestBody("application/json".toMediaType()))
            .addHeader("X-Play-Integrity-Token", integrityToken)
            .build()
    }
}
// Server decodes and verifies the token via Google's API
```

#### Not This

```kotlin
// Simple API key that any modified APK or script can extract and reuse
val request = Request.Builder()
    .url(apiUrl)
    .addHeader("X-API-Key", BuildConfig.API_KEY) // Extractable from APK
    .addHeader("X-App-Version", BuildConfig.VERSION_NAME) // Spoofable
    .build()
```

**Why it's wrong:** `BuildConfig.API_KEY` is a string constant compiled into the APK — extractable with `apktool` or `jadx` in seconds. Play Integrity tokens are cryptographically signed by Google and verify that the app is genuine (not repackaged), the device has integrity (not rooted/emulated), and the app is licensed (installed from Play Store).

### Backup Exclusion (iOS)

#### Do This

```swift
// Exclude sensitive files from iCloud backup
func excludeFromBackup(fileURL: URL) throws {
    var url = fileURL
    var resourceValues = URLResourceValues()
    resourceValues.isExcludedFromBackup = true
    try url.setResourceValues(resourceValues)
}

// Store Keychain items as device-only (not synced to iCloud Keychain)
let query: [String: Any] = [
    kSecClass as String:       kSecClassGenericPassword,
    kSecAttrAccount as String: "session_token",
    kSecValueData as String:   tokenData,
    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    // "ThisDeviceOnly" = not synced to iCloud Keychain, not included in backups
]
SecItemAdd(query as CFDictionary, nil)
```

#### Not This

```swift
// Default file storage — included in iCloud backup automatically
let documentsDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
let tokenFile = documentsDir.appendingPathComponent("session.token")
try tokenData.write(to: tokenFile)
// This file will be backed up to iCloud and visible in unencrypted iTunes backups

// Keychain with kSecAttrAccessibleAfterFirstUnlock — syncs to iCloud Keychain
let query: [String: Any] = [
    kSecClass as String:       kSecClassGenericPassword,
    kSecAttrAccount as String: "session_token",
    kSecValueData as String:   tokenData,
    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
    // Synced to iCloud Keychain — accessible on all user's devices
]
```

**Why it's wrong:** Files in the Documents directory are included in iCloud and iTunes backups by default. Unencrypted iTunes backups are plaintext on disk. Keychain items without `ThisDeviceOnly` sync to iCloud Keychain, making session tokens available on every device signed into that Apple ID. Sensitive data should stay on the device where it was created.

### Backup Exclusion (Android)

#### Do This

```kotlin
// AndroidManifest.xml — disable auto-backup or exclude sensitive dirs
// Option 1: Disable backup entirely
// <application android:allowBackup="false" ...>

// Option 2: Selective backup exclusion (preferred)
// <application android:fullBackupContent="@xml/backup_rules" ...>

// res/xml/backup_rules.xml:
// <full-backup-content>
//     <exclude domain="sharedpref" path="secure_prefs.xml" />
//     <exclude domain="database" path="sessions.db" />
//     <exclude domain="file" path="tokens/" />
// </full-backup-content>

// For Android 12+ (API 31+), also use data extraction rules:
// <application android:dataExtractionRules="@xml/data_extraction_rules" ...>

// res/xml/data_extraction_rules.xml:
// <data-extraction-rules>
//     <cloud-backup>
//         <exclude domain="sharedpref" path="secure_prefs.xml" />
//         <exclude domain="database" path="sessions.db" />
//     </cloud-backup>
//     <device-transfer>
//         <exclude domain="sharedpref" path="secure_prefs.xml" />
//     </device-transfer>
// </data-extraction-rules>
```

#### Not This

```kotlin
// Default manifest — all app data backed up to Google Drive
// <application android:allowBackup="true" ...>
// Tokens, session data, cached credentials all backed up in plaintext
// Accessible via adb backup on older Android versions
```

**Why it's wrong:** With `allowBackup="true"` (the default), Google auto-backup copies SharedPreferences, databases, and files to Google Drive. On older Android versions, `adb backup` extracts this data without root. An attacker with physical access or Google account compromise can extract session tokens, cached credentials, and sensitive user data from backups.

### Privacy Controls (iOS)

#### Do This

```swift
import AppTrackingTransparency

// Request ATT permission before any tracking
func requestTrackingPermission(completion: @escaping (Bool) -> Void) {
    ATTrackingManager.requestTrackingAuthorization { status in
        switch status {
        case .authorized:
            completion(true)
        case .denied, .restricted, .notDetermined:
            completion(false)
            // Disable all tracking SDKs, analytics identifiers
            disableTracking()
        @unknown default:
            completion(false)
            disableTracking()
        }
    }
}

// Data minimization — only collect what the feature needs
struct LocationRequest {
    let purpose: LocationPurpose

    enum LocationPurpose {
        case navigation  // Precise location needed
        case weather     // City-level sufficient
    }

    var accuracy: CLLocationAccuracy {
        switch purpose {
        case .navigation: return kCLLocationAccuracyBest
        case .weather:    return kCLLocationAccuracyReduced
        }
    }
}
```

#### Not This

```swift
// Tracking without ATT consent — App Store rejection + privacy violation
let idfa = ASIdentifierManager.shared().advertisingIdentifier
Analytics.setUserId(idfa.uuidString) // Used without requesting permission

// Collecting precise location for a feature that only needs city-level
locationManager.desiredAccuracy = kCLLocationAccuracyBest
locationManager.requestAlwaysAuthorization() // "Always" when "WhenInUse" suffices
// Location data sent to analytics backend "for future use"
```

**Why it's wrong:** Using IDFA without ATT consent violates Apple's App Store guidelines and results in rejection. Collecting precise location when approximate suffices violates data minimization principles, increases liability under GDPR/CCPA, and erodes user trust. Always match data collection granularity to the actual feature requirement.

### Privacy Controls (Android)

#### Do This

```kotlin
// Declare accurate Data Safety Section in Play Console
// Only request permissions actually needed by the feature

// Use approximate location when precise isn't needed
if (featureNeedsPreciseLocation) {
    ActivityCompat.requestPermissions(
        activity,
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION),
        REQUEST_CODE
    )
} else {
    // Android 12+ supports approximate-only location
    ActivityCompat.requestPermissions(
        activity,
        arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION),
        REQUEST_CODE
    )
}

// Respect user's permission choices — degrade gracefully
override fun onRequestPermissionsResult(
    requestCode: Int, permissions: Array<String>, grantResults: IntArray
) {
    if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
        enableLocationFeature()
    } else {
        // Feature works without location — use manual city selection
        showManualCitySelector()
    }
}
```

#### Not This

```kotlin
// Requesting all permissions upfront regardless of feature usage
ActivityCompat.requestPermissions(
    activity,
    arrayOf(
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.CAMERA,
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.RECORD_AUDIO
    ),
    REQUEST_CODE
)
// User hasn't used camera or contacts features yet — permission fatigue
```

**Why it's wrong:** Requesting all permissions at launch causes permission fatigue and trains users to tap "Allow" without reading. It also signals to the OS and security reviewers that the app is over-privileged. Request permissions at the moment they are needed, for the feature that needs them, with the minimum granularity required.

## Exceptions

- **Debug/development builds:** Certificate pinning may be relaxed in debug builds to allow proxy-based debugging. Use build-type-specific Network Security Config on Android or conditional pinning on iOS. Never ship a production build with relaxed pinning.
- **Enterprise MDM environments:** Some enterprise deployments require trusting additional certificate authorities for traffic inspection. This must be a documented, deliberate configuration — not a blanket disabling of certificate validation.
- **Server-derived configuration:** API keys that are intentionally public (e.g., Firebase config, Google Maps client key) may be embedded in the binary. These must be restricted server-side (API key restrictions, app attestation) so the exposed key cannot be abused.
- **Platform-specific storage limitations:** Some cross-platform frameworks (React Native, Flutter) may not have direct Keychain/Keystore access. Use a maintained wrapper library (e.g., `react-native-keychain`, `flutter_secure_storage`) that delegates to the platform secure storage — never fall back to AsyncStorage, SharedPreferences, or plain files.

## Cross-References

- [Security](core-security) — Input validation (R1), secrets management (R4)
- [Mobile Platform Configuration](mobile-platform-configuration) — ATS, Network Security Config, permissions
