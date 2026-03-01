import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

// Import functions to test
import {
  validatePlanReview,
  validateCodeReview,
  deriveReviewFiles
} from './review-validator.ts';

const TEST_PROJECT_DIR = join(import.meta.dir, '.test-reviewer-project');
const TEST_DIR = join(TEST_PROJECT_DIR, '.vcp', 'task');

describe('review-validator', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = TEST_PROJECT_DIR;
  });

  afterEach(() => {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  });

  describe('validateCodeReview', () => {
    test('blocks when no ACs in user story', () => {
      const userStory = { acceptance_criteria: [] as Array<{ id: string }> };
      const review = { status: 'approved' };

      const result = validateCodeReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('zero acceptance criteria');
    });

    test('blocks when no user story', () => {
      const review = { status: 'approved' };

      const result = validateCodeReview(review, null);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('missing or unreadable');
    });

    test('blocks when acceptance_criteria_verification missing', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        summary: 'Looks good'
        // Missing acceptance_criteria_verification
      };

      const result = validateCodeReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('acceptance_criteria_verification');
    });

    test('blocks when not all ACs are verified', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }, { id: 'AC3' }]
      };
      const review = {
        status: 'approved',
        acceptance_criteria_verification: {
          details: [
            { ac_id: 'AC1', status: 'IMPLEMENTED', evidence: '', notes: '' },
            { ac_id: 'AC2', status: 'IMPLEMENTED', evidence: '', notes: '' }
            // Missing AC3
          ]
        }
      };

      const result = validateCodeReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('AC3');
    });

    test('blocks approval with unimplemented ACs', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        acceptance_criteria_verification: {
          details: [
            { ac_id: 'AC1', status: 'IMPLEMENTED', evidence: '', notes: '' },
            { ac_id: 'AC2', status: 'NOT_IMPLEMENTED', evidence: '', notes: '' }
          ]
        }
      };

      const result = validateCodeReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('AC2');
      expect(result!.reason).toContain('needs_changes');
    });

    test('allows valid approval with all ACs implemented', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        acceptance_criteria_verification: {
          details: [
            { ac_id: 'AC1', status: 'IMPLEMENTED', evidence: '', notes: '' },
            { ac_id: 'AC2', status: 'IMPLEMENTED', evidence: '', notes: '' }
          ]
        }
      };

      const result = validateCodeReview(review, userStory);
      expect(result).toBeNull();
    });

    test('allows needs_changes with unimplemented ACs', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'needs_changes',
        acceptance_criteria_verification: {
          details: [
            { ac_id: 'AC1', status: 'IMPLEMENTED', evidence: '', notes: '' },
            { ac_id: 'AC2', status: 'NOT_IMPLEMENTED', evidence: '', notes: '' }
          ]
        }
      };

      const result = validateCodeReview(review, userStory);
      expect(result).toBeNull();
    });

    test('blocks approval with PARTIAL ACs', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        acceptance_criteria_verification: {
          details: [
            { ac_id: 'AC1', status: 'IMPLEMENTED', evidence: '', notes: '' },
            { ac_id: 'AC2', status: 'PARTIAL', evidence: '', notes: '' }
          ]
        }
      };

      const result = validateCodeReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('AC2');
      expect(result!.reason).toContain('incomplete');
    });

    test('allows needs_changes with PARTIAL ACs', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'needs_changes',
        acceptance_criteria_verification: {
          details: [
            { ac_id: 'AC1', status: 'IMPLEMENTED', evidence: '', notes: '' },
            { ac_id: 'AC2', status: 'PARTIAL', evidence: '', notes: '' }
          ]
        }
      };

      const result = validateCodeReview(review, userStory);
      expect(result).toBeNull();
    });
  });

  describe('deriveReviewFiles', () => {
    test('returns null when pipeline-tasks.json missing', () => {
      const result = deriveReviewFiles(TEST_DIR);
      expect(result).toBeNull();
    });

    test('returns null when resolved_config missing', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        pipeline_type: 'feature-implement',
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).toBeNull();
    });

    test('derives review files from default feature pipeline', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        pipeline_type: 'feature-implement',
        resolved_config: {
          feature_pipeline: [
            { type: 'requirements', provider: 'sub', model: 'opus' },
            { type: 'planning', provider: 'sub', model: 'opus' },
            { type: 'plan-review', provider: 'sub', model: 'sonnet' },
            { type: 'plan-review', provider: 'sub', model: 'opus' },
            { type: 'plan-review', provider: 'cli', model: 'o3' },
            { type: 'implementation', provider: 'sub', model: 'sonnet' },
            { type: 'code-review', provider: 'sub', model: 'sonnet' },
            { type: 'code-review', provider: 'sub', model: 'opus' },
            { type: 'code-review', provider: 'cli', model: 'o3' },
          ],
        },
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.pipelineType).toBe('feature-implement');
      expect(result!.planReviewFiles).toEqual([
        'plan-review-1.json',
        'plan-review-2.json',
        'plan-review-3.json',
      ]);
      expect(result!.codeReviewFiles).toEqual([
        'code-review-1.json',
        'code-review-2.json',
        'code-review-3.json',
      ]);
    });

    test('derives review files from bugfix pipeline', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        pipeline_type: 'bug-fix',
        resolved_config: {

          bugfix_pipeline: [
            { type: 'rca', provider: 'sub', model: 'sonnet' },
            { type: 'rca', provider: 'sub', model: 'opus' },
            { type: 'plan-review', provider: 'cli', model: 'o3' },
            { type: 'implementation', provider: 'sub', model: 'sonnet' },
            { type: 'code-review', provider: 'sub', model: 'sonnet' },
            { type: 'code-review', provider: 'sub', model: 'opus' },
            { type: 'code-review', provider: 'cli', model: 'o3' },
          ],
        },
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.pipelineType).toBe('bug-fix');
      expect(result!.planReviewFiles).toEqual(['plan-review-1.json']);
      expect(result!.codeReviewFiles).toEqual([
        'code-review-1.json',
        'code-review-2.json',
        'code-review-3.json',
      ]);
    });

    test('handles minimal pipeline with single review stages', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        pipeline_type: 'feature-implement',
        resolved_config: {

          feature_pipeline: [
            { type: 'requirements', provider: 'sub', model: 'opus' },
            { type: 'planning', provider: 'sub', model: 'opus' },
            { type: 'plan-review', provider: 'sub', model: 'sonnet' },
            { type: 'implementation', provider: 'sub', model: 'sonnet' },
            { type: 'code-review', provider: 'sub', model: 'sonnet' },
          ],
        },
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.planReviewFiles).toEqual(['plan-review-1.json']);
      expect(result!.codeReviewFiles).toEqual(['code-review-1.json']);
    });

    test('handles pipeline with no review stages', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        pipeline_type: 'feature-implement',
        resolved_config: {

          feature_pipeline: [
            { type: 'requirements', provider: 'sub', model: 'opus' },
            { type: 'planning', provider: 'sub', model: 'opus' },
            { type: 'implementation', provider: 'sub', model: 'sonnet' },
          ],
        },
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.planReviewFiles).toEqual([]);
      expect(result!.codeReviewFiles).toEqual([]);
    });

    test('defaults to feature-implement when pipeline_type missing', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        resolved_config: {

          feature_pipeline: [
            { type: 'plan-review', provider: 'sub', model: 'sonnet' },
            { type: 'implementation', provider: 'sub', model: 'sonnet' },
            { type: 'code-review', provider: 'sub', model: 'opus' },
          ],
        },
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.pipelineType).toBe('feature-implement');
      expect(result!.planReviewFiles).toEqual(['plan-review-1.json']);
      expect(result!.codeReviewFiles).toEqual(['code-review-1.json']);
    });

    test('per-type indexing is independent across stage types', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        pipeline_type: 'feature-implement',
        resolved_config: {

          feature_pipeline: [
            { type: 'plan-review', provider: 'sub', model: 'sonnet' },
            { type: 'code-review', provider: 'sub', model: 'sonnet' },
            { type: 'plan-review', provider: 'sub', model: 'opus' },
            { type: 'code-review', provider: 'sub', model: 'opus' },
            { type: 'implementation', provider: 'sub', model: 'sonnet' },
          ],
        },
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).not.toBeNull();
      // plan-review indices: 1, 2 (independent of code-review)
      expect(result!.planReviewFiles).toEqual(['plan-review-1.json', 'plan-review-2.json']);
      // code-review indices: 1, 2 (independent of plan-review)
      expect(result!.codeReviewFiles).toEqual(['code-review-1.json', 'code-review-2.json']);
    });

    // ── New format: stages[] array (primary path) ─────────────────────

    test('derives review files from stages[] array (new format)', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        pipeline_type: 'feature-implement',
        resolved_config: {
          feature_pipeline: [
            { type: 'requirements', provider: 'sub', model: 'opus' },
            { type: 'planning', provider: 'sub', model: 'opus' },
            { type: 'plan-review', provider: 'sub', model: 'sonnet' },
            { type: 'implementation', provider: 'sub', model: 'sonnet' },
            { type: 'code-review', provider: 'sub', model: 'sonnet' },
            { type: 'code-review', provider: 'sub', model: 'opus' },
          ],
        },
        stages: [
          { type: 'requirements', output_file: 'user-story/manifest.json', current_version: 1 },
          { type: 'planning', output_file: 'plan/manifest.json', current_version: 1 },
          { type: 'plan-review', output_file: 'plan-review-sub-sonnet-1-v1.json', current_version: 1 },
          { type: 'implementation', output_file: 'impl-result.json', current_version: 1 },
          { type: 'code-review', output_file: 'code-review-sub-sonnet-1-v1.json', current_version: 1 },
          { type: 'code-review', output_file: 'code-review-sub-opus-2-v1.json', current_version: 1 },
        ],
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.planReviewFiles).toEqual(['plan-review-sub-sonnet-1-v1.json']);
      expect(result!.codeReviewFiles).toEqual([
        'code-review-sub-sonnet-1-v1.json',
        'code-review-sub-opus-2-v1.json',
      ]);
    });

    test('stages[] takes precedence over resolved_config', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        pipeline_type: 'feature-implement',
        resolved_config: {
          feature_pipeline: [
            { type: 'plan-review', provider: 'sub', model: 'sonnet' },
            { type: 'plan-review', provider: 'sub', model: 'opus' },
            { type: 'implementation', provider: 'sub', model: 'sonnet' },
            { type: 'code-review', provider: 'sub', model: 'sonnet' },
          ],
        },
        // stages[] has different count — should take precedence
        stages: [
          { type: 'plan-review', output_file: 'plan-review-sub-sonnet-1-v1.json', current_version: 1 },
          { type: 'implementation', output_file: 'impl-result.json', current_version: 1 },
          { type: 'code-review', output_file: 'code-review-sub-sonnet-1-v1.json', current_version: 1 },
        ],
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).not.toBeNull();
      // stages[] has 1 plan-review, not 2 from resolved_config
      expect(result!.planReviewFiles).toEqual(['plan-review-sub-sonnet-1-v1.json']);
      expect(result!.codeReviewFiles).toEqual(['code-review-sub-sonnet-1-v1.json']);
    });

    test('falls back to resolved_config when stages[] is empty', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        pipeline_type: 'feature-implement',
        resolved_config: {
          feature_pipeline: [
            { type: 'plan-review', provider: 'sub', model: 'sonnet' },
            { type: 'implementation', provider: 'sub', model: 'sonnet' },
            { type: 'code-review', provider: 'sub', model: 'sonnet' },
          ],
        },
        stages: [], // empty = fall back to resolved_config
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).not.toBeNull();
      // Legacy naming from resolved_config fallback
      expect(result!.planReviewFiles).toEqual(['plan-review-1.json']);
      expect(result!.codeReviewFiles).toEqual(['code-review-1.json']);
    });

    test('falls back to resolved_config when stages[] has missing output_file', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        pipeline_type: 'feature-implement',
        resolved_config: {
          feature_pipeline: [
            { type: 'plan-review', provider: 'sub', model: 'sonnet' },
            { type: 'code-review', provider: 'sub', model: 'sonnet' },
          ],
        },
        stages: [
          { type: 'plan-review', output_file: 'plan-review-sub-sonnet-1-v1.json' },
          { type: 'code-review' }, // missing output_file — malformed
        ],
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).not.toBeNull();
      // Malformed stages[] discarded entirely, falls back to resolved_config legacy naming
      expect(result!.planReviewFiles).toEqual(['plan-review-1.json']);
      expect(result!.codeReviewFiles).toEqual(['code-review-1.json']);
    });

    test('falls back to resolved_config when stages[] has unknown type', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        pipeline_type: 'feature-implement',
        resolved_config: {
          feature_pipeline: [
            { type: 'plan-review', provider: 'sub', model: 'sonnet' },
          ],
        },
        stages: [
          { type: 'not-a-stage', output_file: 'something.json' },
        ],
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.planReviewFiles).toEqual(['plan-review-1.json']);
    });

    test('falls back to resolved_config when stages[] has path traversal in output_file', () => {
      writeFileSync(join(TEST_DIR, 'pipeline-tasks.json'), JSON.stringify({
        team_name: 'test-team',
        pipeline_type: 'feature-implement',
        resolved_config: {
          feature_pipeline: [
            { type: 'plan-review', provider: 'sub', model: 'sonnet' },
          ],
        },
        stages: [
          { type: 'plan-review', output_file: '../../package.json' },
        ],
      }));

      const result = deriveReviewFiles(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.planReviewFiles).toEqual(['plan-review-1.json']);
    });
  });

  describe('validatePlanReview', () => {
    test('blocks when no ACs in user story', () => {
      const userStory = { acceptance_criteria: [] as Array<{ id: string }> };
      const review = { status: 'approved' };

      const result = validatePlanReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('zero acceptance criteria');
    });

    test('blocks when requirements_coverage missing', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        summary: 'Plan looks good'
        // Missing requirements_coverage
      };

      const result = validatePlanReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('requirements_coverage');
    });

    test('blocks when not all ACs are covered', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }, { id: 'AC3' }]
      };
      const review = {
        status: 'approved',
        requirements_coverage: {
          mapping: [
            { ac_id: 'AC1', steps: ['Step 1'] },
            { ac_id: 'AC2', steps: ['Step 2'] }
            // Missing AC3
          ]
        }
      };

      const result = validatePlanReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('AC3');
    });

    test('blocks approval with missing requirements', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        requirements_coverage: {
          mapping: [
            { ac_id: 'AC1', steps: ['Step 1'] },
            { ac_id: 'AC2', steps: ['Step 2'] }
          ],
          missing: ['AC2']
        }
      };

      const result = validatePlanReview(review, userStory);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('block');
      expect(result!.reason).toContain('AC2');
    });

    test('allows valid approval with all ACs covered', () => {
      const userStory = {
        acceptance_criteria: [{ id: 'AC1' }, { id: 'AC2' }]
      };
      const review = {
        status: 'approved',
        requirements_coverage: {
          mapping: [
            { ac_id: 'AC1', steps: ['Step 1'] },
            { ac_id: 'AC2', steps: ['Step 2'] }
          ],
          missing: []
        }
      };

      const result = validatePlanReview(review, userStory);
      expect(result).toBeNull();
    });
  });
});
