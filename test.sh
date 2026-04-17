#!/bin/bash
#
# 压力测试脚本
#
# 用法:
#   ./test.sh                                    # 默认参数
#   ./test.sh -c 200 -n 1000 -i 500             # 指定参数
#   ./test.sh --mode stream -c 50 -i 2000       # 只测流式
#
# 预设场景:
#   ./test.sh scenario quick     # 快速验证 (50并发, 200请求)
#   ./test.sh scenario stream    # 流式压测 (100并发, 流式)
#   ./test.sh scenario full      # 非流式压测 (100并发, 非流式)
#   ./test.sh scenario heavy     # 重压 (500并发, 2000请求)
#   ./test.sh scenario long-input # 长输入测试 (输入2000字符)
#

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CLIENT="$SCRIPT_DIR/pressure_client.js"

# 默认值
HOST="127.0.0.1"
PORT=4000
MODE="mixed"
CONCURRENCY=100
REQUESTS=0
INPUT_LENGTH=100
INTERVAL=3

# 预设场景
run_scenario() {
  case "$1" in
    quick)
      echo "=== 场景: 快速验证 ==="
      HOST=$HOST PORT=$PORT $0 -c 50 -n 200 -i 100 --mode mixed
      ;;
    stream)
      echo "=== 场景: 流式压测 ==="
      HOST=$HOST PORT=$PORT $0 -c 100 -n 500 -i 100 --mode stream
      ;;
    full)
      echo "=== 场景: 非流式压测 ==="
      HOST=$HOST PORT=$PORT $0 -c 100 -n 500 -i 100 --mode full
      ;;
    heavy)
      echo "=== 场景: 重压力测试 ==="
      HOST=$HOST PORT=$PORT $0 -c 500 -n 2000 -i 200 --mode mixed
      ;;
    long-input)
      echo "=== 场景: 长输入测试 ==="
      HOST=$HOST PORT=$PORT $0 -c 50 -n 100 -i 2000 --mode mixed
      ;;
    *)
      echo "未知场景: $1"
      echo "可用: quick, stream, full, heavy, long-input"
      exit 1
      ;;
  esac
  exit $?
}

# 解析参数
while [[ $# -gt 0 ]]; do
  case "$1" in
    scenario)
      run_scenario "$2"
      ;;
    --host)         HOST="$2";         shift 2 ;;
    --port)         PORT="$2";         shift 2 ;;
    --mode)         MODE="$2";         shift 2 ;;
    -c|--concurrency) CONCURRENCY="$2"; shift 2 ;;
    -n|--requests)  REQUESTS="$2";     shift 2 ;;
    -i|--input)     INPUT_LENGTH="$2"; shift 2 ;;
    --interval)     INTERVAL="$2";     shift 2 ;;
    -h|--help)
      echo "用法: $0 [选项] | scenario <名称>"
      echo ""
      echo "选项:"
      echo "  --host <addr>         目标地址 (默认: 127.0.0.1)"
      echo "  --port <port>         目标端口 (默认: 4000)"
      echo "  --mode <mode>         stream | full | mixed (默认: mixed)"
      echo "  -c, --concurrency     并发数 (默认: 100)"
      echo "  -n, --requests        总请求数，0=无限 (默认: 0)"
      echo "  -i, --input           输入文本长度/字符数 (默认: 100)"
      echo "  --interval <sec>      统计间隔 (默认: 3)"
      echo ""
      echo "预设场景:"
      echo "  $0 scenario quick        快速验证 (50并发, 200请求)"
      echo "  $0 scenario stream       流式压测 (100并发)"
      echo "  $0 scenario full         非流式压测 (100并发)"
      echo "  $0 scenario heavy        重压 (500并发, 2000请求)"
      echo "  $0 scenario long-input   长输入 (2000字符)"
      echo ""
      echo "示例:"
      echo "  $0 -c 200 -n 1000 -i 500 --mode stream"
      echo "  $0 scenario heavy"
      exit 0
      ;;
    *)
      echo "未知参数: $1"
      exit 1
      ;;
  esac
done

# 检查客户端脚本
if [ ! -f "$CLIENT" ]; then
  echo "错误: 找不到 $CLIENT"
  exit 1
fi

# 检查服务端是否可达
if ! node -e "
  const https = require('https');
  const req = https.request({hostname:'$HOST',port:$PORT,path:'/',method:'GET',rejectUnauthorized:false}, () => process.exit(0));
  req.on('error', () => { console.error('错误: 无法连接到 https://$HOST:$PORT'); process.exit(1); });
  req.setTimeout(3000, () => { console.error('错误: 连接超时'); process.exit(1); });
  req.end();
" 2>/dev/null; then
  echo "请先启动服务: ./deploy.sh start"
  exit 1
fi

echo "========================================="
echo "  压力测试"
echo "========================================="
echo "  目标:     https://$HOST:$PORT"
echo "  模式:     $MODE"
echo "  并发:     $CONCURRENCY"
echo "  请求数:   ${REQUESTS:-无限}"
echo "  输入长度: $INPUT_LENGTH 字符"
echo "========================================="
echo ""

# 启动客户端
node "$CLIENT" \
  --host "$HOST" \
  --port "$PORT" \
  --mode "$MODE" \
  -c "$CONCURRENCY" \
  -n "$REQUESTS" \
  -i "$INPUT_LENGTH" \
  --interval "$INTERVAL"
