---
id: devops-container-security
title: Container Security
scope: devops
severity: critical
tags: [security, docker, containers, dockerfile, image-scanning, owasp, sigstore, cosign, seccomp, apparmor, rootless, supply-chain]
references:
  - title: "CIS Docker Benchmark"
    url: https://www.cisecurity.org/benchmark/docker
  - title: "OWASP Docker Security Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html
  - title: "Sigstore — cosign"
    url: https://docs.sigstore.dev/cosign/signing/signing_with_containers/
  - title: "Docker — Rootless Mode"
    url: https://docs.docker.com/engine/security/rootless/
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

### Supply Chain and Provenance

8. **Sign container images with Sigstore cosign.** Sign images after build with `cosign sign`. Verify signatures before deployment with `cosign verify`. Store signatures alongside images in the registry (OCI artifacts). Integrate verification into CI/CD pipelines and admission controllers (e.g., Kyverno policy requiring a valid cosign signature). Unsigned images must not reach production.

9. **Use minimal base images.** Use distroless, Alpine, or scratch as base images. A distroless image has ~0 CVEs vs. ~100+ in a full Ubuntu base — fewer packages means fewer vulnerabilities and a smaller attack surface. Justify any larger base image with documented rationale. Never use a full OS image for a statically compiled binary.

10. **Apply seccomp and AppArmor runtime security profiles.** Apply seccomp profiles to restrict system calls available to containers. Use the Docker default seccomp profile at minimum; create custom profiles for tighter restriction. Apply AppArmor profiles on Linux hosts. These profiles prevent container escape via unexpected syscalls. (CWE-250)

11. **Never mount the Docker socket into containers.** The Docker socket (`/var/run/docker.sock`) grants root-equivalent access to the host — any container with socket access can create privileged containers, access the host filesystem, and escape isolation entirely. For CI/CD runners needing Docker: use Docker-in-Docker (DinD) with `--privileged` in isolated VMs, or use Kaniko/Buildah for image building without a Docker daemon.

12. **Run Docker daemon in rootless mode.** Rootless Docker runs the daemon and containers entirely in user namespaces without root privileges on the host. This limits the blast radius of container escapes. Document exceptions where rootless mode is not feasible (e.g., specific network plugins, GPU access). Verify with `docker info | grep rootless`.

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

### Image Signing with cosign

#### Do This

```bash
# Sign image in CI after build and push
cosign sign --key cosign.key myregistry/myapp:v1.2.3@sha256:abc123

# Verify signature before deployment
cosign verify --key cosign.pub myregistry/myapp:v1.2.3@sha256:abc123
```

```yaml
# Kyverno admission policy — reject unsigned images
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signature
spec:
  validationFailureAction: Enforce
  rules:
    - name: check-cosign-signature
      match:
        any:
          - resources:
              kinds: ["Pod"]
      verifyImages:
        - imageReferences: ["myregistry/*"]
          attestors:
            - entries:
                - keys:
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      <your cosign public key>
                      -----END PUBLIC KEY-----
```

#### Not This

```bash
# Deploy images with no signature verification
docker pull myregistry/myapp:latest
kubectl set image deployment/myapp myapp=myregistry/myapp:latest
# No cosign verify — image could be tampered with
```

**Why it's wrong:** Without signature verification, a compromised registry or man-in-the-middle attack can substitute a malicious image. cosign signatures cryptographically prove the image was built by your CI pipeline and has not been modified since signing. Combined with a Kyverno admission policy, unsigned images are rejected before they ever run.

### Runtime Security Profiles

#### Do This

```bash
# Docker: apply custom seccomp profile
docker run \
    --security-opt seccomp=custom-seccomp.json \
    --security-opt apparmor=docker-custom \
    myapp:v1.2.3
```

```yaml
# Kubernetes: apply seccomp profile to pod
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault  # or Localhost for custom profiles
  containers:
    - name: myapp
      securityContext:
        allowPrivilegeEscalation: false
```

#### Not This

```bash
# Disable all syscall filtering
docker run --security-opt seccomp=unconfined myapp:v1.2.3
```

**Why it's wrong:** `seccomp=unconfined` disables all system call filtering, allowing the container to make any kernel syscall — including those used for container escape exploits. The default Docker seccomp profile blocks ~44 dangerous syscalls. Disabling it removes a critical defense layer.

### Docker Socket Exposure Prevention

#### Do This

```yaml
# Use Kaniko for in-cluster image builds — no Docker daemon needed
apiVersion: v1
kind: Pod
metadata:
  name: kaniko-build
spec:
  containers:
    - name: kaniko
      image: gcr.io/kaniko-project/executor:latest
      args:
        - "--dockerfile=Dockerfile"
        - "--context=git://github.com/org/repo.git"
        - "--destination=myregistry/myapp:v1.2.3"
      volumeMounts:
        - name: registry-creds
          mountPath: /kaniko/.docker
  volumes:
    - name: registry-creds
      secret:
        secretName: registry-credentials
```

#### Not This

```yaml
# Mounting Docker socket — gives container full host access
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: builder
      image: docker:latest
      volumeMounts:
        - name: docker-sock
          mountPath: /var/run/docker.sock
  volumes:
    - name: docker-sock
      hostPath:
        path: /var/run/docker.sock
```

**Why it's wrong:** Mounting the Docker socket gives the container root-equivalent access to the host. The container can create new privileged containers, mount the host filesystem (`-v /:/host`), read any secret on the host, and effectively escape all container isolation. This is the most common container escape vector. Use Kaniko or Buildah for image builds that do not require a Docker daemon.

## Exceptions

- Init containers that need root for volume permissions may run as root with a restricted security context, but they must not be long-running and must not have network access.
- Build containers in CI may use broader capabilities but should not be deployed to production environments.

## Cross-References

- [Security](core-security) — Secrets management (R4)
- [DevOps CI/CD Security](devops-cicd-security) — Image scanning in pipelines
- [DevOps Kubernetes Security](devops-kubernetes-security) — Pod security contexts for container runtime constraints
