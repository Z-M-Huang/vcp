---
id: compliance-accessibility
title: Accessibility Compliance
scope: compliance
severity: critical
tags: [compliance, accessibility, ada, section-508, section-504, aca, aoda, eaa, en-301-549, equality-act, psbar, web-accessibility-directive, wcag, a11y, vpat, acr]
references:
  - title: "WCAG 2.1 — Web Content Accessibility Guidelines"
    url: https://www.w3.org/TR/WCAG21/
  - title: "EN 301 549 v3.2.1 — Accessibility Requirements for ICT Products and Services"
    url: https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf
  - title: "Section 508 Standards — ICT Final Rule (36 CFR 1194)"
    url: https://www.access-board.gov/ict/
  - title: "ADA Title II — Web and Mobile Accessibility (28 CFR Part 35)"
    url: https://www.law.cornell.edu/cfr/text/28/35.200
  - title: "ADA Title III — Public Accommodations"
    url: https://www.ada.gov/topics/title-iii/
  - title: "DOJ — Guidance on Web Accessibility and the ADA"
    url: https://www.ada.gov/resources/web-guidance/
  - title: "European Accessibility Act — Directive (EU) 2019/882"
    url: https://eur-lex.europa.eu/eli/dir/2019/882/oj
  - title: "EU Web Accessibility Directive — Directive (EU) 2016/2102"
    url: https://eur-lex.europa.eu/eli/dir/2016/2102/oj
  - title: "Accessible Canada Act (S.C. 2019, c. 10)"
    url: https://laws-lois.justice.gc.ca/eng/acts/A-0.6/
  - title: "Accessible Canada Regulations (SOR/2021-241)"
    url: https://laws-lois.justice.gc.ca/eng/regulations/sor-2021-241/FullText.html
  - title: "AODA — Accessibility for Ontarians with Disabilities Act (IASR, O.Reg. 191/11)"
    url: https://www.ontario.ca/laws/regulation/110191
  - title: "UK Public Sector Bodies Accessibility Regulations 2018"
    url: https://www.legislation.gov.uk/uksi/2018/952/contents
  - title: "Equality Act 2010 — Reasonable Adjustments"
    url: https://www.legislation.gov.uk/ukpga/2010/15/section/20
  - title: "VPAT / ACR — Voluntary Product Accessibility Template"
    url: https://www.itic.org/policy/accessibility/vpat
---

## Principle

Accessibility is a legal obligation in every major market — not an optional enhancement. Different jurisdictions cite different WCAG versions and impose different obligations on public and private sector organizations. There is no single universal baseline that satisfies all laws. Code that claims "WCAG 2.1 AA compliance" without understanding which regulation applies is making an unsubstantiated legal claim.

This standard maps each regulation to its specific conformance requirements and covers the organizational, documentation, audit, procurement, and remediation obligations that apply across jurisdictions. For technical implementation patterns (semantic HTML, ARIA, color contrast, keyboard navigation), see [Accessibility](web-frontend-accessibility).

### Jurisdiction-Specific Conformance Requirements

| Jurisdiction | Regulation | WCAG Baseline | Scope | Key Dates / Notes |
|---|---|---|---|---|
| US (federal agencies) | Section 508 (36 CFR 1194) | WCAG 2.0 A+AA | All ICT procured by federal agencies | E205.4 / E207.2 non-web exceptions |
| US (federal funding) | Section 504 (HHS 2024 rule) | WCAG 2.1 AA | Web & mobile for federal assistance recipients | Applies to recipients of federal financial assistance |
| US (state/local gov) | ADA Title II (28 CFR 35.200) | WCAG 2.1 AA | Web content & mobile apps | Large entities: April 24, 2026. Small entities: April 26, 2027. Exceptions: 28 CFR 35.201 |
| US (private sector) | ADA Title III | No codified WCAG version | Websites, mobile apps, kiosks of public accommodations | DOJ guidance + court precedent → WCAG 2.1 AA as practical standard. No formal rulemaking. |
| EU (public sector) | Web Accessibility Directive 2016/2102 | WCAG 2.1 AA (via EN 301 549 clause 9) | Websites & mobile apps of public sector bodies | Monitoring and reporting per Art. 8 |
| EU (private sector) | EAA Directive 2019/882 | Functional requirements in Annex I (harmonized via EN 301 549) | Products & services per Art. 2 | Applicable June 28, 2025. Microenterprise exemption for services. Art. 14 fundamental alteration / disproportionate burden. |
| Canada (federal) | ACA (S.C. 2019, c. 10) | WCAG AA for published formats (SOR/2021-241) | Federally regulated entities | Requires accessibility plans, feedback processes, progress reports |
| Canada (Ontario) | AODA IASR (O.Reg. 191/11 s.14) | WCAG 2.0 AA (excludes SC 1.2.4, 1.2.5) | Websites & web content for designated organizations | Phased deadlines by org size |
| UK (public sector) | PSBAR 2018 (SI 2018/952) | WCAG 2.1 AA (via EN 301 549) | Websites & mobile apps of public sector bodies | Requires accessibility statement, feedback mechanism. Enforcement via EHRC. |
| UK (all sectors) | Equality Act 2010 s.20 | No specific WCAG version — "reasonable adjustments" duty | Services, public functions, associations | General obligation. WCAG 2.1 AA as practical standard per EHRC guidance. |

## Rules

### Conformance Level

1. **Apply the WCAG baseline that matches your jurisdiction, not a blanket assumption.** Determine which regulations apply to your organization based on jurisdiction, sector (public/private), and funding sources. Use the conformance table above to identify the correct WCAG version and level. An organization subject to Section 508 must meet WCAG 2.0 A+AA. An organization subject to ADA Title II must meet WCAG 2.1 AA. An organization subject to both must meet the stricter standard. Do not claim compliance with a regulation you have not specifically mapped.

2. **Scope ICT accessibility beyond web content.** EN 301 549 and Section 508 cover all information and communication technology — not just websites. This includes desktop software (clause 11), mobile apps (clause 11), documents and PDFs (clause 10), hardware kiosks (clause 8), and authoring tools (clause 11.8.1). Apply WCAG2ICT mapping for non-web software (EN 301 549 clause 11, Section 508 E207.2). Do not treat "web accessibility" as the full scope of your obligation.

3. **Treat AAA conformance as a contractual or best-practice uplift, not a legal default.** No listed regulation mandates WCAG AAA as a baseline. AAA criteria may apply when: (a) a procurement contract or grant specifies it, (b) content targets users with cognitive disabilities and AAA criteria (e.g., SC 3.1.5 Reading Level, SC 1.4.8 Visual Presentation) directly address their needs, or (c) the organization voluntarily commits to it. Do not conflate "best practice" with "legally required."

### Jurisdiction-Specific Requirements

4. **ADA Title II: track compliance deadlines and apply archived content exceptions.** State and local government entities must make web content and mobile apps conform to WCAG 2.1 AA by April 24, 2026 (entities serving 50,000+ population) or April 26, 2027 (smaller entities) per 28 CFR 35.200. Exceptions under 28 CFR 35.201 apply to: archived web content (content not updated after the compliance date and maintained for reference only), preexisting conventional electronic documents (unless used for current programs), and content posted by third parties (where the entity does not control the content). Document which content qualifies for each exception and the rationale.

5. **EAA: apply the correct applicability dates and exemptions.** The European Accessibility Act applies to products and services defined in Art. 2 from June 28, 2025. Products placed on the market before this date may continue until they undergo a "substantial modification." Microenterprises (fewer than 10 persons, annual turnover/balance sheet not exceeding €2 million) are exempt for services only (Art. 4(1) read with Art. 2). Any operator claiming disproportionate burden (Art. 14(1)(d)) or fundamental alteration (Art. 14(1)) must document the assessment formally, reassess at least every five years or when the service changes, and report the assessment to the relevant market surveillance authority on request. The EAA requires conformance with Annex I functional requirements, harmonized through EN 301 549 — it does not cite a specific WCAG version directly.

6. **ACA: maintain the full accessibility plan lifecycle.** Federally regulated entities under the Accessible Canada Act must: (a) publish an initial accessibility plan identifying barriers and planned actions, (b) establish and publicize a feedback process for receiving accessibility complaints and suggestions, (c) publish progress reports on implementation of the plan. Plans must be updated on a schedule defined in the Accessible Canada Regulations (SOR/2021-241). Feedback must be receivable in multiple formats (phone, email, mail, TTY). Progress reports must describe actions taken, results, and feedback received. This is not a one-time exercise — it is a continuous lifecycle.

### Documentation

7. **Publish an accessibility statement that satisfies all applicable jurisdictions.** The statement must include: the conformance standard and level claimed, known accessibility limitations with descriptions and workarounds, the date of the most recent accessibility assessment, contact information for accessibility feedback, and the enforcement body and complaint escalation path. For organizations subject to PSBAR (Reg. 8) or EAA (Art. 14), the statement is a legal requirement with prescribed content. For ADA-subject organizations, DOJ guidance recommends a statement. Use a single statement that covers all applicable jurisdictions rather than separate per-jurisdiction pages. Update it after every audit or material change.

8. **Maintain a VPAT/ACR for procurement contexts.** Organizations selling to US federal agencies must produce a Voluntary Product Accessibility Template (VPAT) following the ITI template format, resulting in an Accessibility Conformance Report (ACR). The ACR must evaluate against Section 508 criteria (which incorporate WCAG 2.0 A+AA) and, if applicable, EN 301 549 and WCAG 2.1. Update the ACR with each major release. Do not publish a VPAT that states "Supports" for criteria that have not been tested — use the correct conformance levels: Supports, Partially Supports, Does Not Support, Not Applicable.

9. **Maintain an internal conformance registry mapping every product/feature to its accessibility status.** For each product, component, or major feature, record: the applicable regulation(s), the target WCAG level, the most recent audit date and result, known non-conformances with severity and remediation timeline, and the responsible team. This registry drives audit scheduling, remediation prioritization, and accurate reporting. Without it, organizations cannot answer "which products are compliant?" — the most basic question a regulator or procurement officer will ask.

### Audit & Testing

10. **Run automated accessibility checks in CI, but do not treat them as sufficient.** Integrate axe-core, jest-axe, or Playwright accessibility assertions into CI pipelines. Configure them to check WCAG 2.x A and AA success criteria relevant to automated detection. Automated testing catches approximately 30–40% of WCAG issues — primarily structural issues (missing alt text, missing form labels, invalid ARIA, insufficient color contrast). It cannot detect: logical reading order, meaningful alt text quality, keyboard trap scenarios in complex widgets, or screen reader announcement correctness. Automated CI checks are a minimum floor, not a ceiling.

11. **Conduct manual assistive technology testing for every release.** Before each release, test critical user flows with: a screen reader (NVDA or JAWS on Windows, VoiceOver on macOS/iOS, TalkBack on Android), keyboard-only navigation, and voice control (Dragon NaturallySpeaking, Voice Control). Test at least: login/registration, primary navigation, form submission, error recovery, and checkout/payment flows. Document the AT versions used, the flows tested, and issues found. This testing covers the 60–70% of issues that automated tools miss.

12. **Conduct a comprehensive accessibility audit annually.** Engage auditors (internal specialists or external firms) to evaluate a representative sample of pages/screens against the full applicable WCAG success criteria. The audit must cover: automated scanning results, manual expert evaluation, and assistive technology testing. Produce a formal report with findings categorized by WCAG success criterion, severity, and affected component. Use the audit to update the conformance registry (rule 9) and the accessibility statement (rule 7).

13. **Include users with disabilities in testing.** Automated and expert testing cannot fully replicate the experience of users who depend on assistive technology daily. Conduct usability testing with participants who have a range of disabilities (visual, motor, cognitive, hearing) at least annually or before major redesigns. This is not a legal requirement in most jurisdictions, but it is the most effective way to identify real-world barriers that technical testing misses.

### Third-Party & Procurement

14. **Require a current VPAT/ACR from every third-party vendor whose product is user-facing.** Before adopting any third-party component, widget, SaaS tool, or platform that end users will interact with, obtain and review the vendor's ACR. Evaluate the ACR against your applicable WCAG baseline — not just whether one exists. A VPAT that says "Partially Supports" for critical criteria (1.1.1 Non-text Content, 2.1.1 Keyboard, 4.1.2 Name Role Value) is a compliance risk, not a compliance artifact.

15. **Conduct a pre-adoption accessibility evaluation for every third-party component.** Before integrating any user-facing third-party component: (a) run an axe-core scan on the component's demo/sandbox, (b) verify keyboard operability of all interactive elements, (c) test critical flows with a screen reader, (d) check color contrast of the component's default theme. Document the evaluation results. If the component fails critical criteria, either choose an alternative or negotiate a remediation timeline with the vendor before integration.

16. **Include accessibility SLAs in vendor contracts.** Contracts for user-facing third-party products must include: the WCAG conformance level required, the timeline for fixing reported accessibility defects (e.g., critical within 30 days, major within 90 days), a requirement to provide updated ACRs with each major release, and the right to audit or test the product's accessibility. Without contractual requirements, vendors have no obligation to maintain or improve accessibility.

### Remediation & Timelines

17. **Triage accessibility defects by impact on user task completion.** Not all WCAG failures have equal user impact. Prioritize by: (a) critical — users cannot complete the task at all (e.g., keyboard trap, unlabeled form, inaccessible authentication), (b) major — users can complete the task but with significant difficulty or workarounds (e.g., poor heading structure, missing error identification), (c) minor — users are inconvenienced but not blocked (e.g., missing skip links, decorative images with alt text). This triage drives remediation timelines and resource allocation.

18. **Set jurisdiction-aware remediation timelines.** For ADA-subject organizations, settlement agreements typically require remediation of critical issues within 90 days and a full remediation plan within 12–18 months — use these as benchmarks even without a pending action. For EAA-subject organizations, the June 28, 2025 applicability date is a hard deadline for services — products placed on the market after this date must conform at launch. For AODA-subject organizations, phased compliance deadlines are defined by org size in O.Reg. 191/11. For PSBAR-subject organizations, monitoring cycles set by the Cabinet Office define reporting periods. Document the timeline rationale for each defect.

19. **Document every known barrier with a workaround.** For every accessibility defect that cannot be fixed immediately, document: the affected component, the WCAG success criterion violated, the user impact, the workaround (if any), and the planned remediation date. Publish known barriers in the accessibility statement (rule 7). Providing workarounds is not optional — it is an interim obligation while the defect persists. A workaround must achieve the same task outcome through an accessible alternative (e.g., phone-based support, alternative page, accessible document).

### Monitoring & Reporting

20. **Run continuous accessibility monitoring on production.** Integrate automated accessibility scanning into production monitoring (not just CI). Scan a representative sample of pages on a recurring schedule (daily or weekly). Alert on regression — new WCAG violations that were not present in the previous scan. Production monitoring catches issues introduced by dynamic content, CMS-authored pages, A/B tests, and third-party script updates that CI pipelines do not cover.

21. **Publish a feedback mechanism and respond to complaints.** PSBAR (Reg. 8), EAA (Art. 14(3)), and AODA IASR (s.11) require a published mechanism for users to report accessibility barriers. Provide multiple channels (web form, email, phone). Acknowledge complaints within 5 business days. Provide a substantive response (assessment, planned action, or workaround) within 30 business days. Log all complaints with: date received, barrier reported, component affected, response date, and resolution. This log is auditable.

22. **Report accessibility status to regulators when required.** PSBAR requires periodic reporting to the Government Digital Service monitoring body. The EU Web Accessibility Directive requires member state monitoring per Art. 8. ACA requires publication of progress reports. Maintain reporting-ready data (conformance registry, audit results, complaint log) so that regulatory reporting is a data extraction exercise, not a scramble.

### Training & Awareness

23. **Train developers, designers, and QA on accessibility fundamentals.** EAA Art. 4(5) requires economic operators to ensure staff have "adequate knowledge" of accessibility requirements. AODA IASR s.7 requires training on applicable accessibility standards. At minimum, train on: WCAG principles (perceivable, operable, understandable, robust), semantic HTML and ARIA usage, keyboard accessibility testing, and screen reader basics. Repeat training annually and include it in onboarding. Training without practice is insufficient — pair it with code review integration (rule 24).

24. **Integrate accessibility checks into code review.** Add an accessibility checklist to pull request templates for UI changes. The checklist should cover: semantic HTML usage, keyboard operability, ARIA attribute correctness, color contrast, focus management, and alt text presence. Reviewers do not need to be accessibility experts — the checklist makes the common issues checkable by any developer. Automated linting (eslint-plugin-jsx-a11y, axe-linter) supplements but does not replace human review of interaction patterns.

### Mobile & Native

25. **Use platform accessibility APIs for native applications.** Mobile and desktop applications must use the platform's native accessibility APIs — not custom overlays or workarounds. On iOS, use `UIAccessibility` traits, labels, and hints. On Android, use `AccessibilityNodeInfo`, `contentDescription`, and `ViewCompat` helpers. On Windows, use MSAA/UIA properties. On macOS, use NSAccessibility. EN 301 549 clause 11 and WCAG2ICT provide the mapping from WCAG success criteria to non-web software. Test with platform-native screen readers (VoiceOver, TalkBack, Narrator) on each release.

## Patterns

### Accessibility Statement

#### Do This

```html
<!--
  Accessibility statement satisfying PSBAR Reg. 8, EAA Art. 14,
  and DOJ ADA guidance. Publish at /accessibility or linked from
  every page footer.
-->
<main>
  <h1>Accessibility Statement</h1>

  <section>
    <h2>Conformance Status</h2>
    <p>
      This website aims to conform to
      <a href="https://www.w3.org/TR/WCAG21/">WCAG 2.1</a> Level AA.
      We assess conformance against the following regulations:
    </p>
    <ul>
      <li>ADA Title III (US) — using WCAG 2.1 AA as the practical standard</li>
      <li>EN 301 549 v3.2.1 (EU) — for EAA and Web Accessibility Directive obligations</li>
    </ul>
  </section>

  <section>
    <h2>Known Limitations</h2>
    <table>
      <thead>
        <tr>
          <th>Component</th>
          <th>Issue</th>
          <th>WCAG Criterion</th>
          <th>Workaround</th>
          <th>Target Fix Date</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Date picker</td>
          <td>Custom widget not keyboard-operable</td>
          <td>2.1.1 Keyboard (A)</td>
          <td>Use the text input field to type dates in YYYY-MM-DD format</td>
          <td>2026-Q2</td>
        </tr>
        <tr>
          <td>Data visualization charts</td>
          <td>Chart data not available to screen readers</td>
          <td>1.1.1 Non-text Content (A)</td>
          <td>Download the CSV data table linked below each chart</td>
          <td>2026-Q3</td>
        </tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2>Assessment</h2>
    <p>
      Last assessed: <time datetime="2026-01-15">January 15, 2026</time>
      by ExampleAudit Inc. using automated scanning (axe-core 4.x),
      manual expert evaluation, and assistive technology testing
      (NVDA 2024.4, VoiceOver on iOS 18).
    </p>
  </section>

  <section>
    <h2>Feedback &amp; Contact</h2>
    <p>
      If you encounter an accessibility barrier, please contact us:
    </p>
    <ul>
      <li>Email: <a href="mailto:accessibility@example.com">accessibility@example.com</a></li>
      <li>Phone: +1-555-0199 (TTY available)</li>
      <li>Web form: <a href="/accessibility/feedback">/accessibility/feedback</a></li>
    </ul>
    <p>We acknowledge complaints within 5 business days and provide a substantive response within 30 business days.</p>
  </section>

  <section>
    <h2>Enforcement</h2>
    <p>UK users: <a href="https://www.equalityadvisoryservice.com/">Equality Advisory Support Service (EASS)</a></p>
    <p>EU users: Contact your national market surveillance authority.</p>
    <p>US users: <a href="https://www.ada.gov/file-a-complaint/">File an ADA complaint with the DOJ</a></p>
  </section>
</main>
```

#### Not This

```html
<footer>
  <p>We strive to make our website accessible to all users.</p>
</footer>
```

**Why it's wrong:** A vague footer statement does not satisfy any jurisdiction's requirements. PSBAR Reg. 8 requires specific content (conformance status, known limitations, feedback mechanism, enforcement link). EAA Art. 14 requires information on accessibility features and their limitations. DOJ guidance expects a published policy with contact information. Without specifics, the statement provides no useful information to users and no legal protection to the organization.

### CI/CD Accessibility Gate

#### Do This

```yaml
# GitHub Actions: automated accessibility checks
# IMPORTANT: This catches ~30-40% of WCAG issues. It is NOT sufficient
# alone — pair with manual AT testing (rule 11) before every release.
name: Accessibility CI
on: [pull_request]

jobs:
  a11y-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      # Static lint: catches common JSX a11y issues at parse time
      - name: ESLint accessibility rules
        run: npx eslint --no-eslintrc --rule '{"jsx-a11y/alt-text":"error","jsx-a11y/aria-props":"error","jsx-a11y/aria-role":"error","jsx-a11y/no-noninteractive-element-interactions":"warn"}' 'src/**/*.{jsx,tsx}'

      # Runtime scan: renders components and runs axe-core against DOM
      - name: Run jest-axe unit tests
        run: npx jest --testPathPattern='\.a11y\.test\.'

      # E2E scan: full pages with Playwright + axe-core
      - name: Playwright accessibility tests
        run: npx playwright test --grep @a11y
```

```typescript
// Example jest-axe test — validates rendered component against WCAG 2.x A/AA
import { render } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { LoginForm } from "./LoginForm";

expect.extend(toHaveNoViolations);

describe("LoginForm accessibility", () => {
  it("has no axe violations at WCAG 2.1 AA", async () => {
    const { container } = render(<LoginForm />);
    const results = await axe(container, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
    });
    expect(results).toHaveNoViolations();
  });
});
```

```typescript
// Example Playwright a11y test — full-page scan
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("home page has no critical a11y violations @a11y", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations.filter((v) => v.impact === "critical")).toEqual([]);
});
```

#### Not This

```yaml
# No accessibility checks in CI at all
name: CI
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
```

**Why it's wrong:** Without automated accessibility checks in CI, accessibility regressions are only caught in manual testing (if at all). Every PR that adds a form field without a label, an image without alt text, or an interactive element without keyboard support passes CI without warning. The cost of fixing accessibility defects grows exponentially the later they are detected. CI checks are a minimum floor — they are not sufficient, but their absence guarantees regressions.

### Complaint Handling Workflow

#### Do This

```python
"""
Accessibility complaint tracking — satisfies:
- EAA Art. 14(3): feedback mechanism for accessibility
- PSBAR Reg. 8: procedure for accessibility complaints
- AODA IASR s.11: accessible formats and communication supports
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Optional


class ComplaintSeverity(Enum):
    CRITICAL = "critical"  # User cannot complete task at all
    MAJOR = "major"        # Task completable with significant difficulty
    MINOR = "minor"        # Inconvenience, not a blocker


class ComplaintStatus(Enum):
    RECEIVED = "received"
    ACKNOWLEDGED = "acknowledged"  # Must occur within 5 business days
    INVESTIGATING = "investigating"
    RESOLVED = "resolved"          # Substantive response within 30 business days
    ESCALATED = "escalated"        # Referred to enforcement body


@dataclass
class AccessibilityComplaint:
    id: str
    date_received: datetime
    reporter_contact: str           # Email, phone, or "anonymous"
    barrier_description: str
    affected_component: str
    wcag_criterion: Optional[str]   # e.g., "2.1.1" — filled during triage
    severity: Optional[ComplaintSeverity] = None
    status: ComplaintStatus = ComplaintStatus.RECEIVED
    acknowledgment_deadline: datetime = field(init=False)
    response_deadline: datetime = field(init=False)
    resolution_notes: str = ""
    workaround_provided: str = ""

    def __post_init__(self) -> None:
        # 5 business days for acknowledgment, 30 for substantive response
        self.acknowledgment_deadline = self._add_business_days(
            self.date_received, 5
        )
        self.response_deadline = self._add_business_days(
            self.date_received, 30
        )

    @staticmethod
    def _add_business_days(start: datetime, days: int) -> datetime:
        current = start
        added = 0
        while added < days:
            current += timedelta(days=1)
            if current.weekday() < 5:  # Monday–Friday
                added += 1
        return current


def acknowledge_complaint(complaint: AccessibilityComplaint) -> None:
    """Send acknowledgment within 5 business days of receipt."""
    if datetime.now() > complaint.acknowledgment_deadline:
        raise ValueError(
            f"Acknowledgment overdue for complaint {complaint.id}. "
            f"Deadline was {complaint.acknowledgment_deadline.isoformat()}"
        )
    complaint.status = ComplaintStatus.ACKNOWLEDGED
    # Send acknowledgment via reporter's preferred channel
    # Include: complaint ID, expected response timeline, interim workaround


def resolve_complaint(
    complaint: AccessibilityComplaint,
    resolution: str,
    workaround: str,
) -> None:
    """Provide substantive response within 30 business days."""
    complaint.status = ComplaintStatus.RESOLVED
    complaint.resolution_notes = resolution
    complaint.workaround_provided = workaround
    # Log for regulatory reporting (PSBAR, ACA progress reports)
```

#### Not This

```python
# Forward to generic inbox with no tracking or deadlines
def handle_a11y_complaint(email_body: str) -> None:
    send_email("support@example.com", "A11y complaint", email_body)
```

**Why it's wrong:** Without structured tracking, the organization cannot prove it responded within required timelines (5-day acknowledgment, 30-day substantive response). Complaints forwarded to generic support are lost, deprioritized, or answered without accessibility expertise. When a regulator asks "how do you handle accessibility complaints?", the answer must be a documented process with SLAs — not "we forward them to support."

### Vendor Accessibility Evaluation

#### Do This

```markdown
# Third-Party Accessibility Evaluation Checklist

## Vendor: [Name]
## Component: [Name and version]
## Evaluator: [Name]
## Date: [YYYY-MM-DD]

### 1. VPAT/ACR Review
- [ ] Vendor provides a current ACR (updated within last 12 months)
- [ ] ACR evaluates against Section 508 / WCAG 2.0 AA criteria
- [ ] ACR evaluates against EN 301 549 (if EU market applies)
- [ ] No "Does Not Support" on Level A criteria
- [ ] "Partially Supports" items reviewed — acceptable for our use case?
- [ ] Remarks explain specific limitations (not just "some issues may exist")

### 2. Automated Scan (axe-core)
- [ ] Ran axe-core against vendor's demo/sandbox
- [ ] Zero critical violations
- [ ] Serious violations reviewed and documented
- [ ] Results: _____ violations (_____ critical, _____ serious, _____ moderate)

### 3. Keyboard Operability
- [ ] All interactive elements reachable via Tab
- [ ] No keyboard traps (can Tab away from every element)
- [ ] Focus indicator visible on all interactive elements
- [ ] Custom widgets operable with expected keys (Enter, Space, Arrow keys)
- [ ] Skip navigation available (if component includes navigation)

### 4. Screen Reader Testing
- [ ] Tested with: [NVDA / JAWS / VoiceOver] version [X]
- [ ] All interactive elements have accessible names
- [ ] Form inputs have associated labels
- [ ] Status messages announced via live regions
- [ ] Custom widgets have appropriate ARIA roles and states

### 5. Contract Requirements
- [ ] Contract specifies WCAG conformance level required
- [ ] Contract includes defect remediation SLAs:
  - Critical: _____ days
  - Major: _____ days
- [ ] Contract requires updated ACR with each major release
- [ ] Contract grants right to audit/test accessibility

### Verdict: [ ] APPROVED  [ ] CONDITIONALLY APPROVED  [ ] REJECTED
### Conditions/Notes:
```

#### Not This

```
Checked the vendor's website. Looks accessible. Approved.
```

**Why it's wrong:** Subjective assessment provides no evidence of due diligence. Without a VPAT review, you do not know the vendor's own assessment of their conformance. Without an automated scan, you miss structural issues that are trivially detectable. Without keyboard and screen reader testing, you miss the most impactful accessibility barriers. If the third-party component introduces accessibility violations, your organization bears the compliance liability — not the vendor (unless you have contractual protections per rule 16).

## Exceptions

- **Archived content (ADA Title II 28 CFR 35.201, EAA Art. 2(2)).** Content that is not updated after the compliance date and is maintained solely for historical reference may be exempt from retroactive remediation under ADA Title II. For EAA, legacy products placed on the market before June 28, 2025 are exempt until they undergo a substantial modification. Document which content qualifies, the rationale for the classification, and ensure the archive is clearly labeled as such to users.

- **Disproportionate burden (EAA Art. 14(1)(d), PSBAR Reg. 7).** An organization may claim disproportionate burden when the cost of making a specific piece of content or functionality accessible is demonstrably disproportionate to the benefit. This requires a formal documented assessment that considers: the net cost, the organization's resources, the frequency of use, and the impact on users with disabilities. The assessment must be reassessed annually and whenever the content or service changes. Interim workarounds that achieve the same task outcome through accessible means are mandatory even when disproportionate burden is claimed. **Note:** ADA case law does not recognize a disproportionate burden defense for digital accessibility — this exception applies only to UK and EU regulations.

- **User-generated content.** Platforms hosting user-generated content are not required to make every piece of user content accessible. However, the platform must: (a) provide accessible authoring tools that make it easy for users to create accessible content (per ATAG 2.0), (b) ensure the platform's own interface for consuming user content is accessible, and (c) provide mechanisms for users to request accessible alternatives of specific content.

- **Third-party iframe content.** Content embedded via iframes from third parties that the organization does not control may not be fully conformant. Document the limitation in the accessibility statement, provide an alternative way to access the information, and require conformance contractually where possible (rule 16). The embedding page's own content must still be fully conformant.

- **Microenterprise exemption (EAA services only, Art. 4(1) read with Art. 2).** Microenterprises (fewer than 10 persons, annual turnover or balance sheet total not exceeding €2 million) are exempt from EAA obligations for services only — products must still conform. This exemption does not apply to other regulations (ADA, PSBAR, AODA, ACA). Organizations claiming this exemption must verify they meet the definition annually.

## Cross-References

- [Accessibility](web-frontend-accessibility) — Technical WCAG 2.2 implementation patterns (semantic HTML, ARIA, color contrast, keyboard navigation)
- [Testing](core-testing) — Testing methodology and quality standards for accessibility test suites
- [Error Handling](core-error-handling) — Accessible error messages and form validation feedback patterns
- [Frontend Structure](web-frontend-structure) — Component architecture supporting accessible design patterns
- [Mobile Security](mobile-security) — Platform-specific considerations for mobile accessibility APIs
