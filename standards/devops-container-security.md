---
id: devops-container-security
title: Container Security
scope: devops
severity: critical
tags: [security, docker, containers, dockerfile, image-scanning, owasp]
references:
  - title: "CIS Docker Benchmark"
    url: https://www.cisecurity.org/benchmark/docker
  - title: "OWASP Docker Security Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html
---

## Principle

A container is an isolation boundary, not a security boundary — unless you make it one. Running as root, embedding secrets in layers, and pulling unverified images collapses that boundary entirely. Container security means minimizing the blast radius: non-root execution, minimal attack surface, pinned dependencies, and no secrets baked into artifacts. Every shortcut taken during image build becomes a persistent vulnerability in production.

## Rules

### Image Construction

1. **Never run containers as root.** Use `USER nonroot` in the Dockerfile. If the base image runs as root, create a non-root user and switch. Running as root inside a container means a container escape gives full host access.

2. **Never pass secrets via build arguments or ENV.** Docker build args and ENV are stored in image layers and visible via `docker history`. Use multi-stage builds with secrets in the build stage only, or use BuildKit secret mounts (`--mount=type=secret`). (CWE-798)

3. **Use multi-stage builds.** Separate build dependencies from runtime. The final image should contain only the compiled application and runtime dependencies — no compilers, package managers, or build tools.

4. **Pin base image digests, not just tags.** Tags are mutable — `node:20` can change under you. Pin to the SHA256 digest (`node@sha256:abc123...`). This ensures reproducible builds and prevents supply chain attacks via image tag poisoning.

5. **Include HEALTHCHECK and use COPY over ADD.** HEALTHCHECK enables orchestrators to detect unhealthy containers. ADD has implicit URL fetching and tar extraction which creates attack surface — use COPY unless you explicitly need those features.

### Runtime Security

6. **Drop all capabilities and run read-only.** At runtime: `--cap-drop=ALL`, add back only what is needed. Use `--read-only` for the root filesystem. Mount specific writable volumes only where needed. Never use `--privileged`.

7. **Scan images for vulnerabilities before deployment.** Use Trivy, Grype, or Snyk Container to scan images in CI. Block deployment if critical or high CVEs are found. Rebuild images regularly to pick up base image security patches.

## Patterns

### Secure Multi-Stage Dockerfile

#### Do This

```dockerfile
# Build stage — contains compilers and build tools
FROM golang:1.22@sha256:a1b2c3d4 AS builder
WORKDIR /build

# Mount secrets at build time only — never stored in layers
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN=$(cat /run/secrets/github_token) \
    go build -o /app ./cmd/server

# Runtime stage — minimal image, non-root user
FROM gcr.io/distroless/static-debian12@sha256:e5f6a7b8
COPY --from=builder /app /app

# Run as non-root
USER nonroot:nonroot

HEALTHCHECK --interval=30s --timeout=3s \
    CMD ["/app", "healthcheck"]

ENTRYPOINT ["/app"]
```

#### Not This

```dockerfile
# Single stage — build tools ship to production
FROM node:20

# Secret baked into image layer — visible via docker history
ENV DB_CONN="host=prod port=5432"

# Running as root (default)
RUN npm install
COPY . .

# No HEALTHCHECK
# Using ADD instead of COPY
ADD https://example.com/config.tar.gz /etc/app/

CMD ["node", "server.js"]
```

**Why it's wrong:** Five problems: (1) Running as root — a container escape gives host access. (2) Secret in ENV — anyone with `docker history` or image access can read it. (3) Single stage — build tools, source code, and devDependencies are all in the production image, expanding the attack surface. (4) No HEALTHCHECK — the orchestrator cannot detect unhealthy containers. (5) ADD fetches from a URL and extracts archives implicitly — COPY is explicit and safer.

### Docker Run with Security Constraints

#### Do This

```bash
# Drop all capabilities, run read-only, no privilege escalation
docker run \
    --cap-drop=ALL \
    --cap-add=NET_BIND_SERVICE \
    --read-only \
    --security-opt=no-new-privileges \
    --tmpfs /tmp:rw,noexec,nosuid \
    --user 65534:65534 \
    myapp:v1.2.3
```

#### Not This

```bash
# Privileged mode — container has full host kernel access
docker run --privileged myapp:latest
```

**Why it's wrong:** `--privileged` gives the container full access to the host kernel — it can mount host filesystems, load kernel modules, and access all devices. Combined with the mutable `latest` tag, this is a supply chain attack waiting to happen. Drop all capabilities and add back only what the application requires.

## Exceptions

- Init containers that need root for volume permissions may run as root with a restricted security context, but they must not be long-running and must not have network access.
- Build containers in CI may use broader capabilities but should not be deployed to production environments.

## Cross-References

- [Security](core-security) — Secrets management (R4)
- [DevOps CI/CD Security](devops-cicd-security) — Image scanning in pipelines
- [DevOps Kubernetes Security](devops-kubernetes-security) — Pod security contexts for container runtime constraints
