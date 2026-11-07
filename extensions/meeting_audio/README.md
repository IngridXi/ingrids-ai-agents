# meeting_audio — 会议录音处理（降噪 · 转写 · 说话人分离 · 声纹识别）

对应能力：把一段会议录音（现场录制或上传）处理成「谁在何时说了什么」，并支持
把人物声音「注册成声纹」，之后的新录音**自动识别并标注人名**。这是主平台小海
转写能力（单说话人、无分离、无声纹）的增量补充。

## 能力

| 环节 | 方案 | 说明 |
|---|---|---|
| 降噪 | noisereduce（MIT） | 谱减法，纯 numpy，本地 |
| 语音转写 | FunASR Paraformer-zh | 中文，带句级时间戳 |
| 说话人分离 | FunASR CAM++（spk_model） | 自动聚类出「谁在何时说」 |
| 说话人识别/声纹 | FunASR CAM++（speaker verification） | 注册声纹 → 余弦比对自动认人 |
| 实时转写 | 能量 VAD 切段 + 段级 ASR + CAM++ | 边录边出「谁说了什么」，未知人声可随手命名 |
| 笔记 | 浏览器 localStorage | 录音同时写要点，纳入纪要 |
| AI 总结/纪要 | 本地 Ollama（qwen3:8b） | 会议内容零上云，实时小结 + 结构化纪要 |
| 会议总结 PPT | python-pptx | 把纪要转成 .pptx 下载 |

## 安装与启动

```bash
# 1) 安装依赖（torch / funasr / modelscope / noisereduce / python-pptx / websockets）
bash setup.sh

# 2) 下载模型权重（一次性，来自 ModelScope，国内可达；约 1GB+）
.venv/bin/python prepare_models.py

# 3) 启动本机服务（HTTP 127.0.0.1:8950 + WS 127.0.0.1:8951）
.venv/bin/python server.py
```

实时总结与纪要需要本机已运行 **Ollama** 并拉取模型（默认 `qwen3:8b`，可用
环境变量 `MEETING_AUDIO_LLM` 换其它模型）。无 Ollama 时自动降级为规则化纪要。

## 测试

离线回归只需要 `requirements-test.txt` 中的依赖，运行 `python test_meeting_audio.py`。
实时 WebSocket 冒烟需准备模型并启动上述本机服务，再手动运行
`.venv/bin/python smoke_ws_realtime.py`，使用仓库里的合成采访录音。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（含实时转写端口） |
| GET | `/speakers` | 列出已注册人物 |
| POST | `/enroll?name=张三` | 上传一段人声注册声纹（body=音频二进制） |
| POST | `/enroll-segment` | 实时段命名注册（JSON: `{segment_id, name}`） |
| DELETE | `/speaker/<id>` | 删除人物 |
| POST | `/transcribe?denoise=1` | 上传会议录音 → 转写+分离+自动识别人物 |
| POST | `/summary` | 实时总结（JSON: `{transcript, notes}`） |
| POST | `/minutes` | 生成会议纪要（JSON: `{transcript, notes, speakers}`） |
| POST | `/ppt` | 生成会议总结 PPT（JSON: `{minutes, title}`） |
| GET | `/download/<file>` | 下载生成的 .pptx |
| WS | `ws://127.0.0.1:8951/realtime` | 实时流式转写 + 说话人识别（int16 PCM 帧） |

`POST` 音频接口的请求体为原始音频字节（wav/mp3/m4a/webm），前端 agent 页面会先统一
解码重采样为 16k 单声道再上传；实时链路经 WebSocket 发送 16k int16 PCM 帧。

## 接入边界与合规

- 模型只在本机加载、推理只读本地临时文件，处理后删除；无云上传、无遥测。
- 声纹库保存在本目录 `speaker_profiles/`（JSON + 向量），由使用方自行管理。
- **AI 判定均为辅助，需人工复核**；会议录制与转写须事先告知参会人员并取得同意；
  声纹识别结果不作为人事、考勤或财务结论。
- 降噪会轻微改变音频，原录音不被转写取代；正式使用前请用真实手机录音/噪声/方言
  做一轮验收。

## 参考来源

开源方案与固定版本登记于项目根 `sources/SOURCE_MANIFEST.json`、`sources/REUSE_MATRIX.csv`
与 `knowledge-collection/ai-services/sources.json`；本扩展未复制上游源码，仅以安装依赖方式
使用 funasr / modelscope / noisereduce，模型权重许可以各模型卡为准。
