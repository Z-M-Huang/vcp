---
id: core-dependency-management
title: Dependency Management
scope: core
severity: critical
tags: [dependencies, supply-chain, slopsquatting, lockfile, security, owasp]
references:
  - title: "Lasso Security — Slopsquatting Research"
    url: https://www.lasso.security/
  - title: "OWASP Agentic AI Top 10 — ASI04 Supply Chain"
    url: https://owasp.org/www-project-top-10-for-large-language-model-applications/
  - title: "CWE-829 — Inclusion of Functionality from Untrusted Control Sphere"
    url: https://cwe.mitre.org/data/definitions/829.html
  - title: "OpenSSF Package Analysis"
    url: https://openssf.org/
---

## Principle

Every dependency is code you didn't write, don't fully control, and are trusting with your users' data. Add dependencies deliberately, verify they exist and are legitimate, and prefer the standard library or a small amount of your own code over adding a package for trivial functionality.

AI hallucinates package names ~20% of the time, with 43% of hallucinated names repeated consistently across sessions (Lasso Security). Attackers register these hallucinated names with malicious code — "slopsquatting." A proof-of-concept package was downloaded 30,000+ times. This is not theoretical. OWASP classifies it as ASI04: Agentic Supply Chain Vulnerabilities.

## Rules

### Verification Before Installation

1. **Verify every dependency exists on its official registry before installing.** Before running `npm install`, `pip install`, or any package manager command, confirm the package exists on the official registry (npmjs.com, pypi.org, rubygems.org, etc.). AI frequently hallucinates plausible-sounding package names that don't exist — or worse, that an attacker has registered. (CWE-829)

2. **Check the package's legitimacy signals.** Before adding a dependency, verify:
   - **Download count** — established packages typically have 1,000+ weekly downloads. A "popular library" with under 100 weekly downloads is suspicious and warrants extra scrutiny.
   - **Publisher/maintainer** — is the publisher a known organization or individual? Check their other packages.
   - **Last publish date** — when was it last updated? Abandoned packages accumulate unpatched vulnerabilities.
   - **Repository link** — does the package link to a real, active source repository?
   - **License** — is the license compatible with your project?

3. **Never install a package based solely on an AI recommendation.** AI may confidently recommend packages that don't exist, have been deprecated, or have known vulnerabilities. Treat every AI-recommended package as unverified until you manually confirm it on the registry.

### Minimal Dependencies

4. **Do not add a dependency for something trivial.** If the functionality can be implemented in 10-20 lines of straightforward code, write it yourself. A dependency for left-padding a string, generating a UUID, or checking if a value is an object adds supply chain risk for zero meaningful benefit.

5. **Evaluate the dependency tree, not just the direct package.** A single `npm install` can add hundreds of transitive dependencies. Before adding a package, check how many dependencies it brings. Prefer packages with few or zero dependencies. Tools like `npm ls`, `pipdeptree`, or `cargo tree` show the full tree.

6. **Prefer well-maintained packages from known publishers.** When a dependency is justified, choose packages that are actively maintained, backed by a known organization or community, have meaningful test suites, and publish regular security updates. A package with one anonymous maintainer and no commits in two years is a liability.

### Lockfile Hygiene

7. **Always commit lockfiles.** `package-lock.json`, `yarn.lock`, `poetry.lock`, `Cargo.lock`, `go.sum` — these files pin exact dependency versions and verify integrity hashes. They must be committed to version control. Without a lockfile, every install can produce a different dependency tree.

8. **Review lockfile changes in every pull request.** Lockfile diffs reveal new dependencies, version changes, and integrity hash changes. Treat unexpected lockfile changes as suspicious — they may indicate a supply chain compromise or accidental dependency addition.

9. **Use lockfile-only installs in CI/CD.** Production builds and CI pipelines must use `npm ci` (not `npm install`), `pip install --require-hashes`, or equivalent lockfile-strict commands. This ensures the exact verified dependency tree is used, not whatever the registry serves at build time.

### Version Management

10. **Pin dependencies to exact versions or narrow ranges.** Avoid `*`, `latest`, or wide version ranges like `>=1.0.0`. Use exact versions (`1.2.3`) or conservative ranges (`~1.2.3` for patches, `^1.2.3` for minor). Wide ranges allow untested versions — including potentially compromised ones — into your build.

11. **Update dependencies deliberately, not automatically.** Dependency updates should be a conscious action: review the changelog, check for breaking changes, run the full test suite. Automated dependency updates that merge without review are a supply chain risk vector.

### Audit

12. **Run security audits on dependencies regularly.** Use `npm audit`, `pip-audit`, `cargo audit`, or equivalent tools as part of CI. Known vulnerabilities in dependencies are the lowest-hanging fruit for attackers — and the easiest to detect and fix.

13. **Use behavioral analysis tools for supply chain risk.** Static legitimacy checks (download counts, maintainer activity, last publish date) cannot detect a compromised popular package before a CVE is published. To mitigate this gap, use tools that analyze package behavior:
    - **Socket.dev** — detects install scripts, network calls, filesystem access, and obfuscated code in npm/Python packages.
    - **OpenSSF Scorecard** — scores projects on security practices (branch protection, signed releases, CI tests, vulnerability disclosure).
    - **npm provenance / Sigstore** — verify that a published package was built from the claimed source repository in a trusted CI environment.
    - Run at least one behavioral analysis tool in CI alongside `npm audit` / `pip-audit`. Static vulnerability databases only catch known issues; behavioral analysis catches suspicious patterns in new versions before a CVE exists.

> **Scope limitation:** No static rule set can fully prevent supply chain compromise of a trusted, actively-maintained package. If a maintainer account is compromised and a malicious version is published that passes all static checks, detection requires runtime behavioral analysis or post-incident response. Rules 1-12 reduce the attack surface; rule 13 adds an additional detection layer; neither guarantees prevention.

## Patterns

### Verify Before Installing

#### Do This

```bash
# AI recommends: pip install python-dateutil-extended
# Step 1: Check if it exists on PyPI
# Visit https://pypi.org/project/python-dateutil-extended/ → 404 Not Found
# This package does not exist. AI hallucinated it.

# Step 2: Find the real package
# The actual package is "python-dateutil" — 200M+ downloads, maintained by dateutil org
pip install python-dateutil
```

```bash
# AI recommends: npm install react-query
# Step 1: Check npmjs.com → exists, but deprecated
# Step 2: The maintained successor is @tanstack/react-query
npm install @tanstack/react-query
```

#### Not This

```bash
# Blindly installing whatever AI recommends without verification
pip install python-dateutil-extended  # Does not exist — may be slopsquatted
npm install huggingface-cli           # Malicious package — 30,000+ downloads before removal
```

**Why it's wrong:** AI hallucinates package names with high confidence. Installing unverified packages can execute arbitrary code during installation (npm postinstall scripts, Python setup.py). A single `pip install malicious-package` can compromise your entire development environment.

### Trivial vs Justified Dependencies

#### Do This

```javascript
// UUID generation — trivial with built-in crypto
function generateId() {
  return crypto.randomUUID();
}

// Left-pad — trivial, no dependency needed
function leftPad(str, length, char = " ") {
  return str.padStart(length, char);
}
```

#### Not This

```javascript
// Adding a dependency for one-liners
import { v4 as uuid } from "uuid";           // 18 transitive deps for crypto.randomUUID()
import leftPad from "left-pad";               // Entire package for String.padStart()
import isArray from "is-array";               // Package for Array.isArray()
```

**Why it's wrong:** Each dependency is code you trust with your users' data. `uuid` pulls in 18 transitive dependencies where `crypto.randomUUID()` is built-in. `left-pad` is one line of code. Each added package is an attack surface, a maintenance burden, and a build-time cost — for zero benefit over built-in language features.

### Lockfile Discipline

#### Do This

```bash
# CI/CD: strict lockfile install — fails if lockfile is out of sync
npm ci                              # Uses package-lock.json exactly
pip install --require-hashes -r requirements.txt  # Verifies integrity hashes

# Development: update lockfile deliberately
npm update lodash                   # Update one specific package
npm install                         # Regenerate lockfile
git diff package-lock.json          # Review what changed before committing
```

#### Not This

```bash
# CI/CD: loose install — can pull different versions each run
npm install                         # Ignores lockfile, resolves fresh

# Development: no lockfile committed
echo "package-lock.json" >> .gitignore  # Lockfile excluded from version control
```

**Why it's wrong:** Without a committed lockfile and strict CI installs, every build resolves dependencies fresh from the registry. A compromised package published between your last test run and your production deploy will be silently included. Lockfiles pin the exact versions and integrity hashes you tested against.

### Reviewing AI Package Recommendations

```
AI says: "Use the 'flask-restplus' package for REST APIs"

Verification checklist:
✓ Exists on PyPI? Yes — but last updated 2020
✓ Download count? Declining — 50K/month and falling
✓ Maintainer active? No — no commits in 4+ years
✓ Known issues? Yes — archived, recommends migration to flask-restx
✗ Should I use it? No — use flask-restx (active fork, maintained)
```

## Exceptions

- **Internal/private registries** with pre-vetted packages may have lighter verification requirements, since packages are published by trusted internal teams. Lockfiles and version pinning still apply.
- **Development-only dependencies** (linters, formatters, test runners) have lower risk than runtime dependencies since they don't ship to production. Verification is still recommended but the bar for "trivial" is lower.
- **Monorepo internal packages** that reference sibling packages via workspace protocols (`workspace:*`) don't need registry verification — they're your own code.

## Cross-References

- [Security](core-security) — Dependency verification as a security boundary
- [Code Quality](core-code-quality) — Minimal dependencies reduce complexity and maintenance burden
