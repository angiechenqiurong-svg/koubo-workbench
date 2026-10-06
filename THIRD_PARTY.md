# 第三方组件

发行包只包含本项目源码，不打包第三方可执行文件、Python 环境或模型权重。以下组件在安装时单独获取：

| 组件 | 用途 | 官方来源 / 许可证 |
| --- | --- | --- |
| Puppeteer Core | 操作独立 Chrome 读取公开视频页面 | [Puppeteer](https://github.com/puppeteer/puppeteer)，Apache-2.0 |
| FFmpeg / FFprobe 安装器 | 下载对应系统的视频处理组件 | [ffmpeg-installer](https://github.com/kribblo/node-ffmpeg-installer)、[ffprobe-installer](https://github.com/SavageCore/node-ffprobe-installer)；安装器与二进制的许可证分别以其发行说明为准 |
| FFmpeg / FFprobe | 解码、音频提取、视频信息 | [FFmpeg 许可证说明](https://ffmpeg.org/legal.html)；具体构建依配置适用 LGPL 或 GPL |
| faster-whisper | 本机音频听写 | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)，MIT |
| CTranslate2 | CPU 推理 | [OpenNMT/CTranslate2](https://github.com/OpenNMT/CTranslate2)，MIT |
| PyAV | 音频解码 | [PyAV](https://github.com/PyAV-Org/PyAV)，BSD；关联 FFmpeg 的许可证另行适用 |
| OpenCC Python | 繁体转简体 | [opencc-python](https://github.com/yichen0831/opencc-python)，以依赖包 LICENSE 为准 |
| Whisper base 模型 | 中文语音模型 | [Systran/faster-whisper-base](https://huggingface.co/Systran/faster-whisper-base)，模型卡标注 MIT；下载固定版本 `ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66` |
| Apple Vision | 可选画面文字识别 | macOS 系统框架，适用 Apple 条款 |

模型首次安装单独从官方 Hugging Face 仓库下载。Chrome 由用户自行从官方来源安装，本项目不包含或修改 Chrome。第三方依赖的完整树可由 `package-lock.json` 和安装后的 Python 包信息查看。
