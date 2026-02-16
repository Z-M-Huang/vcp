---
id: devops-kubernetes-security
title: Kubernetes Security
scope: devops
severity: high
tags: [security, kubernetes, k8s, rbac, pod-security, network-policy]
references:
  - title: "CIS Kubernetes Benchmark"
    url: https://www.cisecurity.org/benchmark/kubernetes
  - title: "Kubernetes — Pod Security Standards"
    url: https://kubernetes.io/docs/concepts/security/pod-security-standards/
  - title: "NSA/CISA Kubernetes Hardening Guide"
    url: https://www.nsa.gov/Press-Room/News-Highlights/Article/Article/2716980/nsa-cisa-release-kubernetes-hardening-guidance/
---

## Principle

Kubernetes defaults are optimized for ease of adoption, not security. By default, pods run as root, any pod can talk to any other pod, service accounts get tokens auto-mounted, and Secrets are just base64-encoded. Every cluster that runs with defaults is one compromised pod away from full cluster takeover. Kubernetes security means overriding every permissive default: non-root pods, default-deny network policies, scoped RBAC, and external secret management.

## Rules

### Pod Security

1. **Never run pods as privileged or as root.** Set `securityContext.runAsNonRoot: true`, `securityContext.privileged: false`, and `securityContext.allowPrivilegeEscalation: false`. Use the `restricted` Pod Security Standard as the baseline.

2. **Set resource requests and limits on every container.** Without limits, a single pod can consume all node resources and crash other workloads. Set CPU and memory requests (for scheduling) and limits (for OOM protection). Use LimitRanges and ResourceQuotas as namespace-level guardrails.

3. **Drop all capabilities and add only what is needed.** Set `securityContext.capabilities.drop: ["ALL"]`. Add back specific capabilities (e.g., `NET_BIND_SERVICE`) only if required. Most applications need zero Linux capabilities.

### Access Control

4. **Use namespace-scoped RBAC with no wildcards.** Never assign `cluster-admin` to service accounts. Avoid wildcard (`*`) verbs or resources in RBAC rules. Scope roles to specific namespaces. Disable auto-mounting of service account tokens (`automountServiceAccountToken: false`) for pods that do not need Kubernetes API access.

### Network Isolation

5. **Apply default-deny NetworkPolicies.** Create a `NetworkPolicy` that denies all ingress and egress by default for each namespace. Then create specific policies that allow only required traffic. Without network policies, any pod can communicate with any other pod in the cluster.

### Secrets Management

6. **Use external secret managers instead of Kubernetes Secrets.** Kubernetes Secrets are base64-encoded, not encrypted (at rest in etcd they may be encrypted depending on cluster config). Use External Secrets Operator, HashiCorp Vault with CSI driver, or AWS Secrets Manager with CSI driver. At minimum, enable etcd encryption at rest.

### Scanning and Admission Control

7. **Scan manifests and images in CI.** Use kubesec, kube-score, or Trivy for manifest scanning. Scan container images before deployment. Enforce admission policies with OPA/Gatekeeper or Kyverno to reject non-compliant pods.

## Patterns

### Secure Pod Specification

#### Do This

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web-app
  template:
    metadata:
      labels:
        app: web-app
    spec:
      # Disable service account token auto-mount
      automountServiceAccountToken: false

      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        fsGroup: 65534
        seccompProfile:
          type: RuntimeDefault

      containers:
        - name: web-app
          image: myregistry/web-app@sha256:a1b2c3d4
          ports:
            - containerPort: 8080

          # Resource boundaries
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi

          # Restrictive security context
          securityContext:
            allowPrivilegeEscalation: false
            privileged: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]

          # Writable tmp only where needed
          volumeMounts:
            - name: tmp
              mountPath: /tmp

      volumes:
        - name: tmp
          emptyDir:
            sizeLimit: 100Mi
```

#### Not This

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web-app
  template:
    metadata:
      labels:
        app: web-app
    spec:
      # No security context — runs as root by default
      containers:
        - name: web-app
          image: myregistry/web-app:latest
          ports:
            - containerPort: 8080
          # No resource limits — can consume entire node
          # No capability restrictions — inherits all default capabilities
          # Service account token auto-mounted by default
```

**Why it's wrong:** Four critical defaults left in place: (1) No `securityContext` — the container runs as root with all default Linux capabilities, meaning a container escape gives root on the node. (2) No resource limits — a memory leak or fork bomb in this pod can OOM-kill every other pod on the node. (3) Mutable `latest` tag — the deployed image can change without any code change, breaking reproducibility and enabling supply chain attacks. (4) Service account token auto-mounted — if the pod is compromised, the attacker can query the Kubernetes API with whatever permissions the service account has.

### Default-Deny NetworkPolicy

#### Do This

```yaml
# Default deny all traffic in the namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress

---
# Allow only specific traffic
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-web-to-api
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-server
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: web-frontend
      ports:
        - protocol: TCP
          port: 8080
```

#### Not This

```yaml
# No NetworkPolicy at all — every pod can reach every other pod
# A compromised frontend pod can directly access the database,
# the metadata service, other namespaces, and the Kubernetes API
```

**Why it's wrong:** Without network policies, Kubernetes allows all pod-to-pod communication across the entire cluster by default. A compromised web pod can directly connect to databases, cache servers, internal APIs, the cloud metadata service (169.254.169.254), and even the Kubernetes API server. Default-deny forces you to explicitly declare every allowed communication path, limiting lateral movement.

### Scoped RBAC

#### Do This

```yaml
# Namespace-scoped Role with specific permissions
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: app-deployer
  namespace: production
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "update"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: app-deployer-binding
  namespace: production
subjects:
  - kind: ServiceAccount
    name: deploy-bot
    namespace: production
roleRef:
  kind: Role
  name: app-deployer
  apiGroup: rbac.authorization.k8s.io
```

#### Not This

```yaml
# cluster-admin bound to a service account — full cluster access
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: deploy-bot-admin
subjects:
  - kind: ServiceAccount
    name: deploy-bot
    namespace: production
roleRef:
  kind: ClusterRole
  name: cluster-admin
  apiGroup: rbac.authorization.k8s.io
```

**Why it's wrong:** `cluster-admin` grants unrestricted access to every resource in every namespace — including Secrets, RBAC bindings, and node-level operations. If the `deploy-bot` service account token is compromised (via a pod vulnerability, leaked token, or SSRF), the attacker has full cluster control: read all secrets, deploy malicious workloads, delete infrastructure, and pivot to the cloud provider via service account annotations. Scoped RBAC limits the blast radius to exactly what the service account needs.

## Exceptions

- DaemonSets for monitoring or logging (Fluentd, Prometheus Node Exporter) may require specific host access or capabilities (e.g., `hostNetwork`, `hostPID`). Document which capabilities are needed and why.
- Cluster setup jobs may need elevated RBAC temporarily. Use a time-bound or job-scoped service account, not a persistent `cluster-admin` binding.
- Development clusters may relax network policies for debugging, but should be isolated from production and should not share credentials or service accounts.

## Cross-References

- [DevOps Container Security](devops-container-security) — Non-root containers, image scanning
- [Security](core-security) — Least privilege, secrets management
- [DevOps IaC Security](devops-iac-security) — Infrastructure-level controls
