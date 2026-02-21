import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

// Import functions to test
import {
  validatePlanReview,
  validateCodeReview,
  deriveReviewFiles
} from './review-validator.ts';

const TEST_DIR = join(import.meta.dir, '.test-task');

describe('review-validator', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = join(import.meta.dir, '.test-task').replace('.task', '');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
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
