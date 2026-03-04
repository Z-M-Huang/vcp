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

## 工作原理

对于每个计划步骤（1 到 N）：

1. **实现**：实现者代理以 SINGLE_STEP_MODE 运行，只实现那一个步骤。
2. **审查**：配置的分阶段审查者检查该步骤的变更。
   - 顺序审查者依次运行。
   - 设置了 `parallel: true` 的审查者同时运行。
3. **判决**：
   - **全部通过**：更新进度，进入步骤 N+1。
   - **任何需要修改**：为该步骤创建修复任务，重新审查，最多重复 `max_phased_iterations` 次。
4. **升级**：如果一个步骤耗尽所有迭代次数，流水线暂停并要求你介入。
5. **完成**：所有步骤通过后，编排器汇总结果并写入 `impl-result.json`。然后最终代码审查关卡独立运行。

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
    ├── phased-review-anthropic-subscription-sonnet-step-1-v1.json
    ├── phased-review-anthropic-subscription-sonnet-step-2-v1.json
    └── phased-review-anthropic-subscription-sonnet-step-3-v2.json
```

## 恢复支持

如果流水线运行在步骤中途中断，进度会通过 `step_progress` 字段记录在 `pipeline-tasks.json` 中。下次运行时，编排器检测到部分进度并从正确的步骤恢复。已完成的步骤不会重新运行。

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
- 升级时，只能手动接管或中止——流水线永远不会自动跳过失败的步骤。
