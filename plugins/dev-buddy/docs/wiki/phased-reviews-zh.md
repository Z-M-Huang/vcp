# 分阶段实现审查

## 什么是分阶段审查？

分阶段审查在流水线的实现阶段添加增量验证关卡。每实现一个计划步骤后，一个或多个审查模型会在下一步开始之前验证该步骤。这样可以在缺陷引入的地方及早发现问题，而不是只在最终代码审查关卡才发现。

## 为什么使用分阶段审查？

- **早期缺陷检测**：步骤 3 中的问题在步骤 4-16 在有缺陷的基础上构建之前就能被发现。
- **更小的修复范围**：审查者标记问题时，只需要修复那一个步骤——而不是整个实现。
- **独立验证**：可以使用与实现不同的提供商或模型进行审查。
- **增量置信度**：每个通过的步骤都让你有信心继续前进。

## 如何配置

在你的流水线配置（`~/.vcp/dev-buddy.json`）中，向任意 `implementation` 阶段条目添加 `phased_reviews` 数组：

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

### 分阶段审查条目字段

| 字段 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `provider` | 字符串 | 是 | AI 预设配置中的预设名称 |
| `model` | 字符串 | 是 | 模型名称（格式与阶段模型相同） |
| `parallel` | 布尔值 | 否 | 为 true 时，与同样设置了 `parallel: true` 的相邻审查者并行运行 |

### 顶层设置

| 字段 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `max_phased_iterations` | 整数 | 3 | 在升级到用户之前，每步的最大修复/重审周期数 |
| `review_interval` | 整数 | 1 | 每 N 个实现步骤后进行审查。默认值：1（每步审查）。 |

## 审查间隔（批量审查）

默认情况下（`review_interval: 1`），每个步骤在实现后立即审查。将 `review_interval` 设置为更高的值可以在触发审查之前批量多个步骤：

```json
{
  "review_interval": 3,
  "max_phased_iterations": 3
}
```

以 `review_interval: 3` 和 11 步计划为例：
- 批次 1：实现步骤 1、2、3 → 审查批次 [1-3]
- 批次 2：实现步骤 4、5、6 → 审查批次 [4-6]
- 批次 3：实现步骤 7、8、9 → 审查批次 [7-9]
- 批次 4：实现步骤 10、11 → 审查批次 [10-11]（余数）

**优势：**
- 审查者可以看到跨步骤的累积上下文，发现跨步骤一致性问题
- 减少审查者调用总数（11 步 / 3 间隔 = 4 次审查而不是 11 次）
- 每次批量审查包含先前批次摘要，提供关于之前工作的上下文

**修复行为：** 当批量审查返回 `needs_changes` 时，修复按步骤进行（实现者仍以 SINGLE_STEP_MODE 工作）。所有步骤级修复完成后，重新审查同一批次。

## 工作原理

对于每个计划步骤（1 到 N）：

1. **实现**：实现者代理以 SINGLE_STEP_MODE 运行，只实现那一个步骤。
2. **批次检查**：如果批次完成（批次中的步骤数 >= `review_interval` 或这是最后一步），进入审查。否则，更新进度并继续下一步。
3. **审查**：配置的分阶段审查者检查该批次的变更。
   - 顺序审查者依次运行。
   - 设置了 `parallel: true` 的审查者同时运行。
   - 批量审查包含批次中的所有计划步骤文件和实现步骤文件，以及先前批次摘要。
4. **判决**：
   - **全部通过**：更新进度（包括 `last_reviewed_step`），进入下一批次。
   - **任何需要修改**：创建步骤级修复任务，重新审查该批次，最多重复 `max_phased_iterations` 次。
5. **升级**：如果一个批次耗尽所有迭代次数，流水线暂停并要求你介入。
6. **完成**：所有步骤通过后，编排器汇总结果并写入 `impl-result.json`。然后最终代码审查关卡独立运行。

## 每步产物

分阶段审查产物存储在 `.vcp/task/` 下的两个目录中：

```
.vcp/task/
├── impl-steps/
│   ├── impl-step-1-v1.json      # 步骤 1 实现结果（v1）
│   ├── impl-step-2-v1.json      # 步骤 2 实现结果
│   ├── impl-step-3-v1.json      # 步骤 3 第一次尝试
│   └── impl-step-3-v2.json      # 步骤 3 修复后（v2）
└── phased-reviews/
    ├── phased-review-anthropic-subscription-sonnet-step-1-v1.json    # interval=1
    ├── phased-review-anthropic-subscription-sonnet-steps-1-3-v1.json # interval>1（批量）
    └── ...
```

## 恢复支持

如果流水线运行在步骤中途中断，进度会通过 `step_progress` 字段（包括用于批次跟踪的 `last_reviewed_step`）记录在 `pipeline-tasks.json` 中。下次运行时，编排器检测到部分进度，推导 `batch_start = last_reviewed_step + 1`，并从正确的步骤恢复。已完成和已审查的步骤不会重新运行。

## Web 门户配置

Web 门户（`/dev-buddy-config`）在每个实现阶段卡片上包含一个可折叠的**分阶段审查**部分：

1. 打开 Pipeline Config（流水线配置）标签页。
2. 找到你的实现阶段卡片。
3. 点击 **Phased Reviews (0)** 展开该部分。
4. 点击 **+ Add Reviewer** 添加分阶段审查者条目。
5. 为每个审查者配置提供商、模型和可选的并行标志。
6. 拖动审查者以重新排序。
7. 在 Pipeline Settings（流水线设置）中设置 **Max Phased Review Iterations per Step**（每步最大分阶段审查迭代次数）。
8. 点击 **Save Config**（保存配置）。

## 限制条件

- `phased_reviews` 只能设置在 `implementation` 阶段条目上。
- 每个实现阶段最多 10 个分阶段审查者。
- `max_phased_iterations` 必须是正整数（默认值：3）。
- `review_interval` 必须是正整数（默认值：1）。
- 升级时，只能手动接管或中止——流水线永远不会自动跳过失败的步骤。
