# SD Agent Studio 需求文档 V1.0

## 1. 产品摘要

`SD Agent Studio` 是一个独立 Windows 桌面端生图 Agent，底层优先对接本地 Aki / Stable Diffusion WebUI，同时支持接入 OpenAI、OpenAI-compatible、本地小模型服务和 Anthropic/Claude 类协议模型。

产品目标是让用户通过自然语言完成生图、改图、批量创作、模型选择、参数配置和 LoRA 炼制，降低 Stable Diffusion 的使用门槛，同时保留高级用户对 prompt、参数、模型、LoRA、ControlNet 和训练配置的控制权。

第一版产品定位为专业创作工作台，不做纯聊天玩具，不做营销型 SaaS 首页，不隐藏所有参数。Agent 的每一步自动决策都需要可见、可编辑、可回退。

## 2. 背景与问题

当前 Aki / Stable Diffusion WebUI 已具备完整生图能力，包括文生图、图生图、局部重绘、ControlNet、ADetailer、WD14 Tagger、高清放大、模型管理和 LoRA 使用能力。但普通用户面对 WebUI 时存在明显门槛：

- 不知道如何把中文需求转换成有效 prompt。
- 不理解正面提示词、负面提示词、采样器、CFG、steps、seed、高清修复等参数。
- 不知道何时使用 txt2img、img2img、inpaint、ControlNet 或 upscale。
- 不知道该选择哪个 checkpoint、LoRA、VAE 或 ControlNet 模型。
- LoRA 炼制流程分散，需要懂图片清洗、裁剪、打标签、训练参数和测试评估。

`SD Agent Studio` 的核心价值是把这些专业操作封装成可解释的 Agent 工作流：用户说目标，Agent 拆解任务、生成方案、调用工具、反馈结果，并允许用户随时手动接管。

## 3. 目标用户

### 3.1 新手创作者

特征：

- 不会写 prompt。
- 不熟悉 Stable Diffusion 参数。
- 期望输入中文描述即可生成头像、壁纸、角色图。

核心诉求：

- 用自然语言出图。
- 能看懂系统为什么这么设置。
- 失败时知道怎么改。

### 3.2 插画与头像创作者

特征：

- 需要稳定产出同风格图片。
- 关注画面质量、构图、角色一致性。
- 需要批量生成和筛图。

核心诉求：

- 快速生成多方案。
- 支持多轮修改。
- 支持 LoRA、ControlNet、高清修复和局部重绘。

### 3.3 LoRA 用户

特征：

- 有一组人物、角色、画风或产品图片。
- 不熟悉数据集处理和训练参数。
- 希望一键或半自动炼制可用 LoRA。

核心诉求：

- 自动质检图片。
- 自动裁剪和打标签。
- 自动推荐训练参数。
- 训练后能判断过拟合或欠拟合。

### 3.4 高级 SD 用户

特征：

- 熟悉 WebUI 和参数。
- 希望 Agent 提效，而不是完全替代人工判断。

核心诉求：

- 所有自动结果可编辑。
- 支持手动指定模型、LoRA、ControlNet 和参数。
- 支持批量任务、任务队列、失败重试和资源监控。

## 4. 产品目标与非目标

### 4.1 产品目标

- 让用户只输入中文描述即可生成可用图片。
- 自动生成正面提示词、负面提示词和基础参数。
- 支持多轮对话式改图和生图迭代。
- 支持模型资源扫描与用途索引。
- 支持 LoRA 从数据导入到训练配置生成的完整向导。
- 支持多 Provider 接入，用于理解、规划、prompt、标签清洗和评估。
- 保留高级参数编辑能力，避免黑盒。

### 4.2 非目标

- 第一版不替代 Stable Diffusion 生图模型。
- 第一版不优先提供云端生图 SaaS。
- 第一版不重构 Aki / WebUI 核心源码。
- 第一版不承诺全自动训练出商业级 LoRA，只要求可完成智能向导和基础评估闭环。
- 第一版静态 UI 产品图不要求真实交互和真实接口调用。

## 5. 产品形态

第一版按独立 Windows 桌面端设计。桌面端负责：

- 提供专业工作台 UI。
- 管理用户任务、项目、Provider 配置和资源索引。
- 调用本地 Aki / SD WebUI API。
- 调用本地或远程 LLM Provider。
- 调用 LoRA 训练器，例如 `kohya_ss` 或 `sd-scripts`。

底层 WebUI 仍负责实际 SD 推理。Agent 不直接改写 WebUI 核心流程，而是通过 API 和文件系统资源完成调度。

## 6. 信息架构

主导航包含 7 个一级页面：

1. 总览工作台
2. 自然语言生图
3. 智能改图
4. LoRA 炼制
5. 模型管家
6. 任务队列
7. Provider / API 设置

全局区域：

- 左侧导航：页面入口、当前 WebUI 状态、GPU 状态。
- 顶部状态栏：Provider 状态、WebUI 连接状态、当前项目、全局生成按钮。
- 主工作区：页面核心操作。
- 右侧或底部详情区：参数、Agent 解释、日志、任务状态。

## 7. 核心功能需求

### 7.1 总览工作台

目标：让用户快速看到当前创作系统状态和最近任务。

功能：

- 展示当前 WebUI 连接状态。
- 展示当前 Provider 状态。
- 展示 GPU / VRAM 使用情况。
- 展示当前运行任务。
- 展示最近生成图片。
- 展示最近 LoRA 训练状态。
- 提供快捷入口：自然语言生图、智能改图、LoRA 炼制、扫描模型、连接测试。

验收：

- 用户打开软件后能在 10 秒内知道系统是否可用。
- WebUI 未连接或 Provider 异常时有明确提示。

### 7.2 自然语言生图

目标：用户输入中文需求，Agent 自动生成 SD 生成方案。

输入：

- 自然语言需求。
- 可选：风格、用途、画幅、参考图、模型偏好。

Agent 输出：

- 任务类型：txt2img。
- 正面提示词。
- 负面提示词。
- 推荐 checkpoint。
- 推荐 LoRA。
- 推荐 ControlNet。
- width / height。
- sampler。
- steps。
- CFG。
- seed。
- batch size。
- hires fix。
- ADetailer。
- 解释说明。

用户操作：

- 编辑正面提示词。
- 编辑负面提示词。
- 修改参数。
- 锁定某些参数。
- 生成图片。
- 继续输入修改要求。

多轮修改必须支持：

- “脸更温柔”
- “背景换成海边”
- “保持人物，换成夜景”
- “再出 8 张不同构图”
- “更像头像，不要全身”

验收：

- 用户输入中文描述后，系统能生成可编辑方案。
- 点击生成后能调用本地 WebUI `txt2img`。
- 下一轮修改能继承上一轮上下文。

### 7.3 智能改图

目标：用户上传图片并用自然语言描述修改要求，Agent 自动选择合适工作流。

输入：

- 原图。
- 可选蒙版。
- 自然语言修改要求。

Agent 判断：

- 使用 img2img、inpaint、ControlNet、ADetailer 或 upscale。
- 是否保持构图。
- 是否保持角色。
- 是否需要蒙版。
- denoise strength。
- ControlNet 类型。
- 推荐重绘区域。

Agent 展示示例：

```text
任务类型：局部重绘
保持内容：人物脸部和姿势
修改区域：背景
建议 denoise：0.45
建议 ControlNet：depth
```

验收：

- 用户能看到 Agent 为什么选择该工作流。
- 用户能修改 denoise、ControlNet 和提示词。
- 结果区支持原图/结果图对比。

### 7.4 LoRA 炼制助手

目标：将 LoRA 炼制流程做成向导式工作台，降低数据处理和训练参数门槛。

流程：

1. 导入图片集
2. 图片质检
3. 图片分组
4. 自动裁剪
5. 自动打标签
6. 标签清洗
7. 训练配置生成
8. 启动训练
9. 样张评估
10. 一键安装

质检维度：

- 清晰度
- 分辨率
- 重复图片
- 主体占比
- 水印/文字
- 风格一致性
- 人脸完整度
- 姿势多样性
- 服装/背景干扰

训练配置：

- base model
- resolution
- repeats
- epochs
- batch size
- learning rate
- network dim
- network alpha
- optimizer
- trigger word
- caption strategy

训练完成输出：

- 推荐 LoRA 权重。
- 推荐触发词。
- 测试样张。
- 是否过拟合/欠拟合判断。
- 使用示例。
- 一键复制或安装到 `models/Lora`。

验收：

- 用户能从图片导入走到训练配置生成。
- 系统能给出剔除图片建议。
- 系统能生成可编辑标签和训练配置。

### 7.5 模型管家

目标：扫描本地模型资源，建立用途索引，供 Agent 选择。

扫描范围：

- checkpoint
- LoRA
- VAE
- ControlNet
- embeddings
- upscaler

模型信息：

- 名称
- 文件路径
- 类型
- 基础架构：SD1.5 / SDXL / 其他
- 推荐用途
- 标签
- 触发词
- 推荐权重
- 最近使用时间

示例：

```text
animagineXL40：SDXL / 二次元 / 插画 / 角色图
anything-v5：SD1.5 / 二次元 / 头像 / 轻量出图
```

验收：

- 用户能看到本地资源列表。
- Agent 能基于用途标签推荐模型。
- 用户能手动编辑用途标签和触发词。

### 7.6 任务队列

目标：统一管理生图、改图、放大、训练和评估任务。

功能：

- 展示任务类型。
- 展示状态：等待、运行、完成、失败、已暂停。
- 展示进度。
- 展示 GPU/VRAM 占用。
- 支持失败重试。
- 支持暂停和取消。
- 支持查看日志。

验收：

- 同时存在生图和 LoRA 训练任务时，用户能看懂资源占用和顺序。
- 任务失败时提供失败原因和重试入口。

### 7.7 Provider / API 设置

目标：配置用于 Agent 推理的 LLM Provider。

Provider 类型：

- OpenAI
- OpenAI-compatible
- 本地模型服务
- Anthropic/Claude 类接口

配置项：

- Provider 名称
- Base URL
- API Key
- 模型名
- 超时时间
- 最大输出长度
- 连接测试
- 默认用途：prompt、标签、评估、规划

验收：

- 用户能完成 Provider 新增、编辑、启用、禁用。
- 连接失败时显示明确错误。
- 没有 Provider 时，本地 WebUI 原功能不受影响。

## 8. Agent 决策原则

Agent 必须遵循：

- 先解释，再执行。
- 能本地完成的任务优先本地完成。
- 生成前给用户可编辑方案。
- 不自动覆盖用户锁定参数。
- 不静默替换用户指定模型。
- 失败时给出原因和下一步建议。
- 所有 prompt、参数、模型选择、LoRA 推荐都要留痕。

## 9. 关键工作流

### 9.1 自然语言生图工作流

1. 用户输入自然语言。
2. Agent 识别任务意图。
3. Agent 扫描当前可用模型上下文。
4. LLM 生成结构化方案。
5. 系统校验方案参数。
6. UI 展示方案。
7. 用户编辑或确认。
8. 系统调用 WebUI `txt2img`。
9. 输出图片进入画廊。
10. 多轮对话继续迭代。

### 9.2 智能改图工作流

1. 用户导入图片。
2. 用户描述修改目标。
3. Agent 判断工具链。
4. 系统生成改图方案。
5. 用户确认蒙版、denoise、ControlNet。
6. 系统调用 img2img/inpaint/ControlNet。
7. 展示前后对比。

### 9.3 LoRA 炼制工作流

1. 用户导入图片集。
2. 系统完成图片扫描和质检。
3. Agent 给出剔除建议。
4. 用户确认数据集。
5. 系统裁剪与打标签。
6. Agent 清洗标签并生成训练配置。
7. 用户确认训练。
8. 系统调用训练器。
9. 定期生成测试样张。
10. Agent 评估训练结果。
11. 用户一键安装 LoRA。

## 10. UI 设计要求

整体风格：

- 专业桌面工作台。
- 深色为主，但避免单一蓝黑色调。
- 信息密度高。
- 参数区和结果区并排。
- 不做营销首页。
- 不做大面积空洞欢迎页。

视觉结构：

- 左侧固定导航。
- 顶部状态栏。
- 中央任务工作区。
- 右侧参数与 Agent 解释面板。
- 下方或侧边任务队列入口。

关键原则：

- Agent 自动决策必须可见。
- 用户能从方案中直接改 prompt 和参数。
- LoRA 流程需要清晰步骤条。
- 任务失败状态要明显。
- 长文本不能溢出按钮或面板。

## 11. 数据对象草案

### 11.1 GenerationPlan

```json
{
  "task_type": "txt2img",
  "positive_prompt": "string",
  "negative_prompt": "string",
  "checkpoint": "string",
  "lora": ["string"],
  "controlnet": ["string"],
  "width": 832,
  "height": 1216,
  "sampler": "DPM++ 2M Karras",
  "steps": 28,
  "cfg_scale": 6.5,
  "seed": -1,
  "batch_size": 4,
  "hires_fix": true,
  "adetailer": true,
  "rationale": "string"
}
```

### 11.2 EditPlan

```json
{
  "task_type": "inpaint",
  "preserve": ["face", "pose"],
  "modify": ["background"],
  "denoise_strength": 0.45,
  "controlnet": "depth",
  "positive_prompt": "string",
  "negative_prompt": "string",
  "rationale": "string"
}
```

### 11.3 LoraTrainingPlan

```json
{
  "project_name": "string",
  "trigger_word": "string",
  "base_model": "string",
  "resolution": 768,
  "repeats": 10,
  "epochs": 12,
  "batch_size": 2,
  "learning_rate": "1e-4",
  "network_dim": 32,
  "network_alpha": 16,
  "optimizer": "AdamW8bit",
  "caption_strategy": "wd14 + llm cleanup"
}
```

## 12. 验收标准

产品验收：

- 自然语言生图页面能完整表达“中文输入 -> Agent 方案 -> 可编辑参数 -> 生成结果”。
- 智能改图页面能完整表达“上传图 -> 修改指令 -> 工作流判断 -> 前后对比”。
- LoRA 页面能完整表达“图片导入 -> 质检 -> 标签 -> 配置 -> 训练 -> 评估”。
- 模型管家能展示本地模型用途索引。
- 任务队列能展示多类型任务和失败重试。
- Provider 设置能展示多协议配置和连接测试。

体验验收：

- 新手能看懂下一步该做什么。
- 高级用户能看到关键参数并手动修改。
- 页面不依赖大段说明文案也能表达功能。
- UI 产品图能体现专业桌面工作台气质。

技术验收：

- 不影响本地 WebUI 原功能。
- Provider 连接失败不阻塞本地生图。
- 所有 Agent 输出在执行前可编辑。
- 关键任务有日志和失败原因。

## 13. 默认假设

- 第一版按独立 Windows 桌面端设计。
- 底层优先对接本地 Aki / SD WebUI。
- 大模型主要负责理解、规划、prompt、参数和评估，不直接替代 SD 生图。
- “A社协议”默认按 Anthropic/Claude 类接口规划。
- LoRA 训练默认接入 `kohya_ss` 或 `sd-scripts`。
- UI 高保真产品图先做静态展示，不要求真实交互。

