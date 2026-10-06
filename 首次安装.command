#!/bin/zsh
set -e
cd "$(dirname "$0")"
trap 'echo "安装未完成，请根据上方提示处理后重试。按任意键关闭。"; read -k 1' ERR
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "请先安装 Node.js 22 或 24：https://nodejs.org/zh-cn/download"
  read -k 1
  exit 1
fi
node -e 'if(Number(process.versions.node.split(".")[0])<22){console.error("需要 Node.js 22 或更新版本");process.exit(1)}'
npm ci
npm run setup:speech
npm run doctor
echo "安装完成。以后双击“启动口播工作台.command”即可。按任意键关闭。"
read -k 1
