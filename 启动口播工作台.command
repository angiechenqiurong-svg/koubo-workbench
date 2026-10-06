#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if /usr/bin/curl -fsS http://127.0.0.1:4317/api/bootstrap >/dev/null 2>&1; then
  /usr/bin/open http://127.0.0.1:4317
  echo "口播工作台已在运行，可以关闭这个窗口。"
  exit 0
fi
if ! command -v node >/dev/null || [[ ! -d node_modules ]]; then
  echo "请先运行“首次安装.command”。按任意键关闭。"
  read -k 1
  exit 1
fi
(sleep 2; /usr/bin/open http://127.0.0.1:4317) &
node server.mjs
echo "工作台已停止。重新双击即可启动。按任意键关闭。"
read -k 1
