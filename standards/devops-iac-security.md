---
id: devops-iac-security
title: Infrastructure as Code Security
scope: devops
severity: high
tags: [security, terraform, pulumi, cloudformation, iam, infrastructure, policy-as-code, drift-detection, tfsec, checkov]
references:
  - title: "CIS AWS Foundations Benchmark"
    url: https://www.cisecurity.org/benchmark/amazon_web_services
  - title: "OWASP — Infrastructure as Code Security Cheat Sheet"
    url: https://cheatsheetseries.owasp.org/cheatsheets/Infrastructure_as_Code_Security_Cheat_Sheet.html
---

## Principle

Infrastructure as Code turns misconfigurations into version-controlled, reproducible, deployable mistakes. A wildcard IAM policy, a public S3 bucket, or an unencrypted database written in Terraform will be provisioned identically across every environment. IaC security means encoding least-privilege, encryption-by-default, and network isolation into the templates themselves — not hoping someone catches the misconfiguration in a manual review.

## Rules

### Credentials

1. **Never hardcode credentials in IaC templates.** No AWS keys, database passwords, or API tokens in Terraform, Pulumi, CloudFormation, or Helm values. Use secret references (AWS Secrets Manager ARN, Vault paths, GCP Secret Manager). Scan IaC files with tools like tfsec, checkov, or trivy config. (CWE-798)

### Identity and Access

2. **Apply least-privilege IAM policies.** Never use `*` for actions or resources in IAM policies. Define specific actions on specific resources. Use conditions (source IP, MFA) where possible. Audit IAM policies with access analyzer tools.

### Storage Access

3. **Do not create public S3 buckets or equivalent.** Block public access at the account level (`s3:BlockPublicAccess`). Individual buckets should not override this. Equivalent applies to GCS buckets and Azure Blob containers — no public access by default.

### Network Security

4. **Restrict network security groups to specific ports and sources.** Never allow `0.0.0.0/0` inbound on sensitive ports (22, 3306, 5432, 6379, 27017). Database and cache ports should only be accessible from application subnets. Use VPC endpoints for AWS service access.

### Encryption

5. **Encrypt all storage at rest.** Enable encryption for S3, EBS, RDS, DynamoDB, and equivalent services. Use customer-managed keys (CMK) for sensitive workloads. Never leave storage unencrypted.

### State Management

6. **Lock and encrypt state files.** Terraform state contains secrets in plaintext. Store state in encrypted backends (S3 + DynamoDB locking, Terraform Cloud, GCS with encryption). Never commit state files to version control. Restrict state file access to deployment pipelines only.

### Continuous Validation

7. **Run policy-as-code scanning in CI.** Run tfsec, checkov, Sentinel, or OPA on every PR that modifies IaC files. Block merging on policy failures. Define policies for: no public buckets, no wildcard IAM, encryption required, no open security groups. Treat policy violations as build failures, not warnings. (OWASP A02)

8. **Deploy drift detection and alerting.** Alert when infrastructure diverges from declared state. Use `terraform plan` in CI on a schedule, or tools like driftctl or Spacelift. Manual console changes create untracked security gaps — a developer opening a port "temporarily" in the console bypasses all IaC review. Alert on drift and require reconciliation through IaC. (CWE-1188)

9. **Pin Terraform module sources with checksums.** Pin all Terraform module sources to exact versions. Use `.terraform.lock.hcl` for provider locking. Prefer private registries for internal modules. Verify module source authenticity before first use. Never reference `ref=main` — use tagged releases with version constraints. (OWASP A03)

## Patterns

### Least-Privilege IAM Policy

#### Do This

```hcl
# Specific actions on specific resources — least privilege
resource "aws_iam_policy" "app_policy" {
  name = "app-read-bucket"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:ListBucket"]
      Resource = [
        "arn:aws:s3:::my-app-data",
        "arn:aws:s3:::my-app-data/*"
      ]
    }]
  })
}
```

#### Not This

```hcl
# Wildcard everything — full admin access
resource "aws_iam_policy" "app_policy" {
  name = "app-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "*"
      Resource = "*"
    }]
  })
}
```

**Why it's wrong:** `Action: *` on `Resource: *` grants full AWS administrator access. If the application or its credentials are compromised, the attacker can delete infrastructure, exfiltrate data from any service, create new IAM users, and pivot to every resource in the account. IAM policies should grant exactly the permissions the application needs — no more.

### Private, Encrypted S3 Bucket

#### Do This

```hcl
resource "aws_s3_bucket" "data" {
  bucket = "my-app-data"
}

# Block all public access
resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Encrypt at rest with customer-managed key
resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data_key.arn
    }
  }
}
```

#### Not This

```hcl
resource "aws_s3_bucket" "data" {
  bucket = "my-app-data"
  # No public access block — defaults vary by account settings
  # No encryption configuration — data stored in plaintext
  # No versioning — accidental deletes are permanent
}
```

**Why it's wrong:** Without an explicit public access block, the bucket's accessibility depends on account-level defaults — which may not be configured. Without encryption, data is stored in plaintext on S3 infrastructure. A single misconfigured bucket policy or ACL change can expose the entire bucket to the internet. Explicit blocks and encryption make the security posture declarative and version-controlled.

### Restricted Security Group

#### Do This

```hcl
# Database accessible only from application subnet
resource "aws_security_group" "db" {
  name   = "db-access"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
    description     = "PostgreSQL from app tier only"
  }

  # No egress to internet
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [aws_vpc.main.cidr_block]
    description = "Internal VPC only"
  }
}
```

#### Not This

```hcl
# Database open to the entire internet
resource "aws_security_group" "db" {
  name   = "db-access"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all"
  }
}
```

**Why it's wrong:** `0.0.0.0/0` on all ports means every IP address on the internet can attempt connections to the database. Automated scanners will find the open port within hours. Combined with a weak or default password, this results in data exfiltration. Security groups should allow only the specific ports and source IPs/security groups that need access.

### Encrypted Terraform State Backend

#### Do This

```hcl
terraform {
  backend "s3" {
    bucket         = "myorg-terraform-state"
    key            = "prod/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}
```

#### Not This

```hcl
terraform {
  # Local backend — state file on disk, no encryption, no locking
  # State contains database passwords, IAM keys, and resource IDs in plaintext
  # Anyone with file access reads all secrets
  # Committing terraform.tfstate to git exposes everything
}
```

**Why it's wrong:** Terraform state files contain every secret value managed by Terraform in plaintext — database passwords, access keys, private endpoints. A local state file has no encryption, no access control, and no locking. Storing it in version control exposes all secrets to anyone with repo access. An encrypted remote backend with locking prevents both secret exposure and concurrent state corruption.

### Policy-as-Code in CI

#### Do This

```yaml
# GitHub Actions — run tfsec and checkov on IaC changes
name: IaC Security
on:
  pull_request:
    paths: ["infra/**/*.tf", "modules/**/*.tf"]

permissions: {}

jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - uses: actions/checkout@a5ac7e51b41094c92402da3b24376905380afc29 # v4.1.6

      - name: tfsec scan
        uses: aquasecurity/tfsec-action@b842aa196dde9c455e90b85123123123f89f2222 # v1.0.3
        with:
          soft_fail: false  # Fail the build on findings

      - name: checkov scan
        uses: bridgecrewio/checkov-action@abcdef1234567890abcdef1234567890abcdef12 # v12.2.2
        with:
          directory: infra/
          framework: terraform
          soft_fail: false
```

#### Not This

```hcl
# No CI scanning — IaC changes merge without security review
# This wildcard IAM policy ships to production unchecked:
resource "aws_iam_policy" "app_policy" {
  policy = jsonencode({
    Statement = [{
      Effect   = "Allow"
      Action   = "*"
      Resource = "*"
    }]
  })
}
# Manual review missed the wildcard — tfsec would have caught it
```

**Why it's wrong:** Without automated policy scanning, IaC misconfigurations rely on human reviewers to catch every issue — wildcard IAM, public buckets, unencrypted storage, open security groups. Automated tools like tfsec and checkov check hundreds of policies on every PR and block merging before misconfigurations reach production.

### Terraform Module Pinning

#### Do This

```hcl
# Pin to exact version tag — immutable reference
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.5.1"  # Exact version, locked in .terraform.lock.hcl
}

# Private registry for internal modules — version pinned
module "auth" {
  source  = "app.terraform.io/myorg/auth/aws"
  version = "2.1.0"
}

# Git source — pinned to tag, not branch
module "shared" {
  source = "git::https://github.com/myorg/tf-modules.git//networking?ref=v1.3.2"
}
```

#### Not This

```hcl
# Unpinned branch reference — content changes without your knowledge
module "vpc" {
  source = "git::https://github.com/myorg/tf-modules.git//networking?ref=main"
}

# No version constraint — any version can be pulled
module "auth" {
  source = "terraform-aws-modules/vpc/aws"
}
```

**Why it's wrong:** `ref=main` means the module content changes every time someone pushes to main — your infrastructure silently changes without any change to your IaC code. A compromised module or accidental breaking change propagates to every consumer. Pinning to exact versions with lock files ensures reproducible, auditable infrastructure changes.

## Exceptions

- Static website hosting may require public S3/GCS buckets for content, but should use a separate bucket from application data with CloudFront/CDN in front.
- Development environments may have broader network rules for debugging, but should never be exposed to the public internet and should be in an isolated VPC.

## Cross-References

- [Security](core-security) — Secrets management (R4)
- [DevOps CI/CD Security](devops-cicd-security) — OIDC for cloud auth
- [Database Encryption](database-encryption) — Encryption at rest principles
