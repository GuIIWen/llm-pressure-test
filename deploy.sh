#!/bin/bash
#
# pressure_server 部署/管理脚本
#
# 用法:
#   ./deploy.sh start   启动服务
#   ./deploy.sh stop    停止服务
#   ./deploy.sh restart 重启服务
#   ./deploy.sh status  查看状态
#   ./deploy.sh log     查看日志
#

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SERVER_SCRIPT="$SCRIPT_DIR/pressure_server_cluster.js"
PID_FILE="$SCRIPT_DIR/.pressure_server.pid"
LOG_FILE="$SCRIPT_DIR/pressure_server.log"

  # 默认参数（可通过环境变量覆盖）
  WORKERS=${WORKERS:-4}
  HTTPS_PORT=${HTTPS_PORT:-4000}
  HTTP_PORT=${HTTP_PORT:-3000}
  CERT_KEY=${CERT_KEY:-}
  CERT_CERT=${CERT_CERT:-}

start() {
  if [ -f "$PID_FILE" ]; then
    local old_pid
    old_pid=$(cat "$PID_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "服务已在运行 (PID=$old_pid)"
      return 1
    fi
    rm -f "$PID_FILE"
  fi

  if [ ! -f "$SERVER_SCRIPT" ]; then
    echo "错误: 找不到 $SERVER_SCRIPT"
    return 1
  fi

  if [ ! -f "$SCRIPT_DIR/cert/key.pem" ] || [ ! -f "$SCRIPT_DIR/cert/cert.pem" ]; then
    if [ -z "$CERT_KEY" ] || [ -z "$CERT_CERT" ]; then
      echo "WARNING: 证书不可用，将以纯 HTTP 模式启动"
      echo "  如需 HTTPS，请指定证书: CERT_KEY=... CERT_CERT=... ./deploy.sh start"
    fi
  fi

  # 构建环境变量传递
  local env_prefix=""
  [ -n "$CERT_KEY" ]  && env_prefix="CERT_KEY=$CERT_KEY "
  [ -n "$CERT_CERT" ] && env_prefix="${env_prefix}CERT_CERT=$CERT_CERT "
  env_prefix="${env_prefix}HTTPS_PORT=$HTTPS_PORT HTTP_PORT=$HTTP_PORT "

  echo "启动压力测试服务..."
  echo "  Workers: $WORKERS"
  echo "  HTTPS: $HTTPS_PORT  HTTP: $HTTP_PORT"
  echo "  证书: ${CERT_KEY:-./cert/key.pem} / ${CERT_CERT:-./cert/cert.pem}"
  echo "  日志: $LOG_FILE"

  nohup ${env_prefix}node "$SERVER_SCRIPT" > "$LOG_FILE" 2>&1 &
  local pid=$!
  echo $pid > "$PID_FILE"

  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    echo "服务已启动 (PID=$pid)"
  else
    echo "启动失败，请查看日志: $LOG_FILE"
    rm -f "$PID_FILE"
    return 1
  fi
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    echo "服务未运行"
    return 0
  fi

  local pid
  pid=$(cat "$PID_FILE")
  echo "停止服务 (PID=$pid)..."

  # 先发 SIGTERM，优雅停止
  kill -TERM "$pid" 2>/dev/null

  # 等待最多 10 秒
  local i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 10 ]; do
    sleep 1
    i=$((i + 1))
  done

  # 还没停就强杀
  if kill -0 "$pid" 2>/dev/null; then
    echo "强制停止..."
    kill -9 "$pid" 2>/dev/null
  fi

  rm -f "$PID_FILE"
  echo "服务已停止"
}

status() {
  if [ ! -f "$PID_FILE" ]; then
    echo "服务未运行"
    return 0
  fi

  local pid
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    echo "服务运行中 (PID=$pid)"
    echo ""
    echo "监听端口:"
    ss -tlnp 2>/dev/null | grep -E ":( $HTTPS_PORT|$HTTP_PORT)" || netstat -tlnp 2>/dev/null | grep -E ":($HTTPS_PORT|$HTTP_PORT)"
    echo ""
    echo "进程信息:"
    ps -p "$pid" -o pid,ppid,%cpu,%mem,rss,etime,cmd --no-headers 2>/dev/null
    echo ""
    echo "Worker 进程:"
    pgrep -P "$pid" 2>/dev/null | while read wp; do
      ps -p "$wp" -o pid,%cpu,%mem,rss,etime --no-headers 2>/dev/null
    done
  else
    echo "服务已停止 (PID 文件过期)"
    rm -f "$PID_FILE"
  fi
}

log() {
  if [ -f "$LOG_FILE" ]; then
    tail -f "$LOG_FILE"
  else
    echo "日志文件不存在"
  fi
}

case "${1:-}" in
  start)   start   ;;
  stop)    stop    ;;
  restart) stop; sleep 1; start ;;
  status)  status  ;;
  log)     log     ;;
  *)
    echo "用法: $0 {start|stop|restart|status|log}"
    echo ""
    echo "环境变量:"
    echo "  WORKERS=4              Worker 数量"
    echo "  HTTPS_PORT=4000        HTTPS 端口"
    echo "  HTTP_PORT=3000         HTTP 重定向端口"
    echo "  CERT_KEY=./cert/key.pem     证书 key 路径"
    echo "  CERT_CERT=./cert/cert.pem   证书 cert 路径"
    echo ""
    echo "示例:"
    echo "  WORKERS=8 ./deploy.sh start"
    echo "  HTTPS_PORT=8443 ./deploy.sh start"
    echo "  CERT_KEY=/etc/ssl/server.key CERT_CERT=/etc/ssl/server.crt ./deploy.sh start"
    exit 1
    ;;
esac
