# Phased Implementation Reviews

## What Are Phased Reviews?

Phased reviews add incremental verification gates during the implementation stage of your pipeline. After each plan step is implemented, one or more reviewer models verify that step before the next step begins. This catches defects close to where they are introduced, rather than discovering them only at the final code-review gate.

## Why Use Phased Reviews?

- **Early defect detection**: Issues in step 3 are caught before steps 4-16 build on faulty foundations.
- **Smaller fix scope**: When a reviewer flags a problem, only that one step needs to be fixed — not an entire implementation.
- **Independent verification**: Use a different provider or model for reviewing than for implementing.
- **Incremental confidence**: Each approved step gives you confidence before proceeding.

## How to Configure

Add a `phased_reviews` array to any `implementation` stage entry in your pipeline config (`~/.vcp/dev-buddy.json`):

```json
{
  "feature_pipeline": [
    ...
    {
      "type": "implementation",
      "provider": "anthropic-subscription",
      "model": "sonnet",
      "phased_reviews": [
        { "provider": "anthropic-subscription", "model": "sonnet" },
        { "provider": "my-api-preset", "model": "claude-sonnet-4", "parallel": true }
      ]
    },
    ...
  ],
  "max_phased_iterations": 3
}
```

### Phased Review Entry Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | Yes | Preset name from your AI presets configuration |
| `model` | string | Yes | Model name (same format as stage model) |
| `parallel` | boolean | No | When true, runs in parallel with adjacent reviewers that also have `parallel: true` |

### Top-Level Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_phased_iterations` | integer | 3 | Maximum fix/re-review cycles per step before escalating to user |
| `review_interval` | integer | 1 | Review after every N implementation steps. Default: 1 (review every step). |

## Review Interval (Batch Reviews)

By default (`review_interval: 1`), each step is reviewed immediately after implementation. Setting `review_interval` to a higher value batches multiple steps before triggering a review:

```json
{
  "review_interval": 3,
  "max_phased_iterations": 3
}
```

With `review_interval: 3` and an 11-step plan:
- Batch 1: Implement steps 1, 2, 3 → review batch [1-3]
- Batch 2: Implement steps 4, 5, 6 → review batch [4-6]
- Batch 3: Implement steps 7, 8, 9 → review batch [7-9]
- Batch 4: Implement steps 10, 11 → review batch [10-11] (remainder)

**Benefits:**
- Reviewers see cumulative context across steps, catching cross-step coherence issues
- Reduces total reviewer invocations (11 steps / 3 interval = 4 reviews instead of 11)
- Each batch review includes a prior batch summary for context about earlier work

**Fix behavior:** When a batch review returns `needs_changes`, fixes are applied step-by-step (the implementer still works in SINGLE_STEP_MODE). After all step-scoped fixes, the same batch is re-reviewed.

## How It Works

For each plan step (1 through N):

1. **Implement**: The implementer agent runs in SINGLE_STEP_MODE, implementing only that one step.
2. **Batch check**: If the batch is complete (steps in batch >= `review_interval` OR this is the last step), proceed to review. Otherwise, update progress and continue to the next step.
3. **Review**: Configured phased reviewers examine the batch's changes.
   - Sequential reviewers run one after another.
   - Reviewers with `parallel: true` run simultaneously.
   - Batch reviews include all plan step files and impl-step files in the batch, plus a prior batch summary.
4. **Verdict**:
   - **All approved**: Update progress (including `last_reviewed_step`), move to next batch.
   - **Any needs_changes**: Create step-scoped fix tasks, re-review the batch, repeat up to `max_phased_iterations`.
5. **Escalation**: If a batch exhausts all iterations, the pipeline pauses and asks you to intervene.
6. **Completion**: After all steps pass, the orchestrator aggregates results and writes `impl-result.json`. The final code-review gate then runs independently.

## Per-Step Artifacts

Phased review artifacts are stored in two directories under `.vcp/task/`:

```
.vcp/task/
├── impl-steps/
│   ├── impl-step-1-v1.json      # Step 1 implementation result (v1)
│   ├── impl-step-2-v1.json      # Step 2 implementation result
│   ├── impl-step-3-v1.json      # Step 3 first attempt
│   └── impl-step-3-v2.json      # Step 3 after fix (v2)
└── phased-reviews/
    ├── phased-review-anthropic-subscription-sonnet-step-1-v1.json    # interval=1
    ├── phased-review-anthropic-subscription-sonnet-steps-1-3-v1.json # interval>1 (batch)
    └── ...
```

## Resume Support

If a pipeline run is interrupted mid-step, progress is tracked in `pipeline-tasks.json` under `step_progress` (including `last_reviewed_step` for batch tracking). On the next run, the orchestrator detects partial progress, derives `batch_start = last_reviewed_step + 1`, and resumes from the correct step. Completed and reviewed steps are not re-run.

## Web Portal Configuration

The web portal (`/dev-buddy-config`) includes a collapsible **Phased Reviews** section on each implementation stage card:

1. Open the Pipeline Config tab.
2. Find your implementation stage card.
3. Click **Phased Reviews (0)** to expand the section.
4. Click **+ Add Reviewer** to add phased reviewer entries.
5. Configure provider, model, and optional parallel flag for each reviewer.
6. Drag reviewers to reorder them.
7. Set **Max Phased Review Iterations per Step** in Pipeline Settings.
8. Click **Save Config**.

## Constraints

- `phased_reviews` may only be set on `implementation` stage entries.
- Maximum 10 phased reviewers per implementation stage.
- `max_phased_iterations` must be a positive integer (default: 3).
- `review_interval` must be a positive integer (default: 1).
- On escalation, only manual takeover or abort is available — the pipeline never auto-skips a failing step.
