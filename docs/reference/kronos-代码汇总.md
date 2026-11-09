# Kronos（shiyu-coder/Kronos）代码汇总

> 仓库：https://github.com/shiyu-coder/Kronos · 论文 arXiv:2508.02739 · 已中 AAAI 2026
> 语言：Python（PyTorch）· 协议：MIT · 规模：92 个文件 · 模型托管 Hugging Face（NeoQuasar）
> 本地克隆：`~/Dev/_reference/Kronos`

## 一句话定位

Kronos 是**第一个开源的金融 K 线（candlestick）基础模型**——把 OHLCV 行情序列当"语言"来建模，在 45+ 全球交易所数据上预训练，输出下一个 K 线预测或 embedding。本质是"用 NLP 的 tokenizer + 自回归 Transformer 吃掉金融时序"。

README 原话：*"the first open-source foundation model for financial candlesticks (K-lines), trained on data from over 45 global exchanges"*。

## 结论先行：对你的价值

**对你当前的科研工作台（审稿/文献/写作/去 AI 味）直接价值低**——它是个纯金融时序模型，跟你的读博日常不搭。但它有两点**间接但扎实**的价值：

1. **如果你碰量化金融 / 时序研究**：这是目前开源里最值得认真对待的金融技术面基础模型，且**自带 A 股（Qlib）微调示例**，正好是你熟悉的中国市场，几行代码就能跑（`Kronos-base` 102M 参数，笔记本 CPU 就能跑）。
2. **作为"垂直领域基础模型"的方法论范本**：它示范了"怎么把**连续数值数据** tokenize 成**离散 token** 再喂自回归 Transformer"——这套思路对任何"非文本数据建模"的研究都有迁移价值。而且代码非常干净模块化，是学习"用 PyTorch 手写一个小而美基础模型"的好教材。

**建议：** 代码可以先归档，不必现在接进工作台；等你真有金融/时序任务时再启用。

## 两阶段框架

```
K 线数据 (OHLCV 连续值)
        │
        ▼  Stage 1: KronosTokenizer（量化）
  把连续多维 K 线 量化成 分层离散 token
    · BSQuantizer（二值球面量化）二值化成 {-1,+1} 码
    · s1_bits = "pre" 粗粒度 token（高位）
    · s2_bits = "post" 细粒度 token（低位）
        │
        ▼  Stage 2: Kronos（预训练）
  decoder-only 自回归 Transformer
  在 token 上做 next-token 预测 → 生成未来 K 线
```

## 目录结构

```
model/
  __init__.py   导出 KronosTokenizer / Kronos / KronosPredictor + model_dict 注册表
  kronos.py     三个主类 + 自回归推理 + 采样（30KB）
  module.py     底层积木（23KB）：BSQ 量化器 / 注意力 / Embedding / Head
finetune/            Qlib A 股示例：config + 数据预处理 + train_tokenizer + train_predictor + qlib_test 回测
finetune_csv/        通用 CSV 微调管线（config_loader + finetune_tokenizer + finetune_base_model + train_sequential）
webui/               Flask web UI（app.py / run.py / templates），localhost:7070
examples/            预测示例（含 akshare 取数、batch、GUI、回测脚本）
tests/               test_kronos_regression.py
```

## 核心实现拆解

### 1. 分层离散 tokenizer（最核心的创新）

`KronosTokenizer`（kronos.py）用 encoder + BSQuantizer + decoder，把连续 OHLCV 压缩成离散码：

```python
class KronosTokenizer(nn.Module, PyTorchModelHubMixin):
    def __init__(self, d_in, d_model, n_heads, ff_dim, n_enc_layers, n_dec_layers, ...,
                 s1_bits, s2_bits, beta, gamma0, gamma, zeta, group_size):
        self.codebook_dim = s1_bits + s2_bits          # 总码长
        self.embed = nn.Linear(self.d_in, self.d_model)
        self.encoder = nn.ModuleList([TransformerBlock(...) for _ in range(n_enc_layers - 1)])
        self.decoder = nn.ModuleList([TransformerBlock(...) for _ in range(n_dec_layers - 1)])
        self.tokenizer = BSQuantizer(self.s1_bits, self.s2_bits, beta, gamma0, gamma, zeta, group_size)
        ...
    def encode(self, x, half=False):
        z = self.embed(x)
        for layer in self.encoder: z = layer(z)
        z = self.quant_embed(z)
        _, _, z_indices = self.tokenizer(z, half=half)   # → 离散 token id
        return z_indices
```

量化器 `BinarySphericalQuantizer`（module.py）来自论文 *Binarized Spherical Quantization*（arXiv:2406.07548）：
- 先 `F.normalize(z)`，再二值化 `z > 0 ? +1 : -1`，用 **straight-through estimator**（`z + (zhat - z).detach()`）保持可导；
- 额外加 codebook 熵惩罚（soft entropy loss）让码本利用率更均匀。

`BSQuantizer` 把码切成 s1/s2 两段，`bits_to_indices` 转成 token id。

### 2. 分层嵌入 + 依赖感知解码

`HierarchicalEmbedding`（module.py）把 s1/s2 两个 token 分别嵌入再融合：

```python
class HierarchicalEmbedding(nn.Module):
    def __init__(self, s1_bits, s2_bits, d_model=256):
        self.emb_s1 = nn.Embedding(2 ** s1_bits, d_model)
        self.emb_s2 = nn.Embedding(2 ** s2_bits, d_model)
        self.fusion_proj = nn.Linear(d_model * 2, d_model)
    def forward(self, token_ids):                 # (s1_ids, s2_ids) 或复合 id 都能进
        s1_emb = self.emb_s1(s1_ids) * math.sqrt(self.d_model)
        s2_emb = self.emb_s2(s2_ids) * math.sqrt(self.d_model)
        return self.fusion_proj(torch.cat([s1_emb, s2_emb], dim=-1))
```

`Kronos.forward` 先出 s1 logits，再采样/给真 s1，用 `DependencyAwareLayer`（一个 cross-attention）让 s2 **条件于 s1** 生成：

```python
s1_logits = self.head(x)                                   # DualHead 的 proj_s1
# teacher forcing 用真 s1，否则 multinomial 采样 s1
sibling_embed = self.embedding.emb_s1(sample_s1_ids)
x2 = self.dep_layer(x, sibling_embed, key_padding_mask=padding_mask)  # s2 条件于 s1
s2_logits = self.head.cond_forward(x2)                     # DualHead 的 proj_s2
```

其余积木都是标准现代 Transformer：`RMSNorm` + `MultiHeadAttentionWithRoPE`（RoPE 位置编码）+ `FeedForward`（SwiGLU：`silu(w1)·w3·w2`）+ pre-norm 残差。时间特征 `TemporalEmbedding` 单独嵌入 minute/hour/weekday/day/month 五个分量。

### 3. 自回归推理 + 采样

`auto_regressive_inference`（kronos.py）：滚动 `max_context` 窗口，逐 token 生成 s1→s2，标准 top-k / top-p 采样，最后 **sample_count 条路径取平均**（概率预测）：

```python
for i in ran(pred_len):
    s1_logits, context = model.decode_s1(input_tokens[0], input_tokens[1], current_stamp)
    sample_pre  = sample_from_logits(s1_logits[:, -1, :], T, top_k, top_p)
    s2_logits   = model.decode_s2(context, sample_pre)
    sample_post = sample_from_logits(s2_logits[:, -1, :], T, top_k, top_p)
    ...   # 写 buffer；超窗口时 torch.roll 滚动
preds = np.mean(preds, axis=1)   # 多路径平均
```

`KronosPredictor` 负责归一化 + 设备自动检测（cuda → mps → cpu）+ 反归一化：

```python
x_mean, x_std = np.mean(x, axis=0), np.std(x, axis=0)
x = (x - x_mean) / (x_std + 1e-5)
x = np.clip(x, -self.clip, self.clip)      # clip=5
...
preds = preds * (x_std + 1e-5) + x_mean     # 反归一化回价格
```

### 4. 模型家族（都挂 Hugging Face）

| 模型 | Tokenizer | Context | 参数量 | 开源 |
|---|---|---|---|---|
| Kronos-mini | Tokenizer-2k | 2048 | 4.1M | ✅ |
| Kronos-small | Tokenizer-base | 512 | 24.7M | ✅ |
| Kronos-base | Tokenizer-base | 512 | 102.3M | ✅ |
| Kronos-large | Tokenizer-base | 512 | 499.2M | ❌ |

## 5 行上手（如果将来用到）

```python
from model import Kronos, KronosTokenizer, KronosPredictor
import pandas as pd

tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
model     = Kronos.from_pretrained("NeoQuasar/Kronos-small")
predictor = KronosPredictor(model, tokenizer, max_context=512)   # 自动选 cuda/mps/cpu

df = pd.read_csv("your_candles.csv")     # 需 open,high,low,close（volume/amount 可选）
df["timestamps"] = pd.to_datetime(df["timestamps"])
pred_df = predictor.predict(
    df=df[:400], x_timestamp=df[:400]["timestamps"],
    y_timestamp=df[400:520]["timestamps"],
    pred_len=120, T=1.0, top_p=0.9, sample_count=1)
print(pred_df.head())
```

## 微调（A 股 Qlib 示例）

`finetune/` 是四步管线，正好演示"怎么把预训练模型适配到自己数据"：

1. `config.py` 改路径（qlib_data_path / dataset_path / save_path / 预训练模型路径）
2. `qlib_data_preprocess.py` 数据切分 → pickle
3. `torchrun train_tokenizer.py` + `torchrun train_predictor.py`（两阶段微调，多 GPU）
4. `qlib_test.py` 回测（top-K 策略，画累计收益曲线）

`finetune_csv/` 是不依赖 Qlib 的通用 CSV 微调管线，`webui/` 是 Flask 可视化（K 线图上叠加预测）。

**注意**：README 明确声明这是**演示用途**，不是生产级量化系统；真实策略要叠加组合优化 + 风险因子中性化才能出稳定 alpha。

## 代码质量点评

- 模块划分清晰：`kronos.py`（对外 API + 推理）vs `module.py`（纯积木），职责干净；
- 全程 `PyTorchModelHubMixin`，`from_pretrained` 直接对接 Hugging Face，模型加载零成本；
- 用 `einops` 的 `rearrange/reduce` 做维度变换，可读性好；
- `predict`/`predict_batch` 的输入校验、NaN 检查、列缺失自动补零做得细致；
- 唯一小坑：`model/kronos.py` 里 `sys.path.append("../")` 是相对路径 hack，脱离了仓库根目录跑要改导入路径。

---

*汇总时间 2026-11-09，基于 `git clone --depth 1` 的源码与 README。*
