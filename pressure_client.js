/*****************************
 *        测试配置区           *
 *****************************/
const TEST_CONFIG = {
  host: '127.0.0.1',
  port: 4000,
  mode: 'mixed',          // 'stream' | 'full' | 'mixed'
  concurrency: 100,
  totalRequests: 0,        // 0 = 持续运行
  inputLength: 100,        // 输入文本长度（字符数）
  reportInterval: 3,
  rejectUnauthorized: false
};

/*****************************
 *      命令行参数解析          *
 *****************************/
function parseArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--host':         TEST_CONFIG.host = args[++i]; break;
      case '--port':         TEST_CONFIG.port = parseInt(args[++i]); break;
      case '--mode':         TEST_CONFIG.mode = args[++i]; break;
      case '--concurrency':
      case '-c':             TEST_CONFIG.concurrency = parseInt(args[++i]); break;
      case '--requests':
      case '-n':             TEST_CONFIG.totalRequests = parseInt(args[++i]); break;
      case '--input':
      case '-i':             TEST_CONFIG.inputLength = parseInt(args[++i]); break;
      case '--interval':     TEST_CONFIG.reportInterval = parseInt(args[++i]); break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
    }
  }
}

function printUsage() {
  console.log(`
用法: node pressure_client.js [选项]

选项:
  --host <addr>       目标地址 (默认: 127.0.0.1)
  --port <port>       目标端口 (默认: 4000)
  --mode <mode>       请求模式: stream | full | mixed (默认: mixed)
  -c, --concurrency   并发数 (默认: 100)
  -n, --requests      总请求数，0=无限 (默认: 0)
  -i, --input         输入文本长度，字符数 (默认: 100)
  --interval <sec>    统计输出间隔秒数 (默认: 3)
  -h, --help          显示帮助

示例:
  node pressure_client.js -c 200 -n 1000 -i 500 --mode stream
  node pressure_client.js -c 50 -i 2000 --mode full --host 192.168.1.100
`);
}

/*****************************
 *      生成请求体             *
 *****************************/
const CHAR_POOL = [];
for (let code = 0x4E00; code <= 0x9FFF; code++) CHAR_POOL.push(String.fromCharCode(code));

function generateRequestBody(length) {
  const chars = [];
  for (let i = 0; i < length; i++) {
    chars.push(CHAR_POOL[Math.floor(Math.random() * CHAR_POOL.length)]);
  }
  return chars.join('');
}

/*****************************
 *        核心逻辑            *
 *****************************/
const https = require('https');

parseArgs();

// 生成请求体
const requestBody = generateRequestBody(TEST_CONFIG.inputLength);
console.log(`输入文本: ${TEST_CONFIG.inputLength} 字符 / ${Buffer.byteLength(requestBody, 'utf-8')} 字节`);

// 统计计数器
const stats = {
  startTime: Date.now(),
  totalSent: 0,
  totalSuccess: 0,
  totalFail: 0,
  stream: { count: 0, totalBytes: 0, totalTime: 0, ttftList: [] },
  full:   { count: 0, totalBytes: 0, totalTime: 0 },
  windowStart: Date.now(),
  windowSuccess: 0,
  latencies: []
};

let isRunning = true;

/*****************************
 *      发送请求              *
 *****************************/
function sendRequest() {
  if (!isRunning) return;
  if (TEST_CONFIG.totalRequests > 0 && stats.totalSent >= TEST_CONFIG.totalRequests) return;

  stats.totalSent++;
  stats.windowSent++;

  // 决定本次请求模式
  let mode;
  if (TEST_CONFIG.mode === 'mixed') {
    mode = Math.random() < 0.5 ? 'stream' : 'full';
  } else {
    mode = TEST_CONFIG.mode;
  }

  const path = mode === 'stream'
    ? '/deepseek-r1-tx/v1/chat'
    : '/deepseek-r1-tx/v1/chat/completions';

  const body = Buffer.from(requestBody, 'utf-8');
  const startTime = Date.now();
  let firstByteTime = 0;

  const req = https.request({
    hostname: TEST_CONFIG.host,
    port: TEST_CONFIG.port,
    path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length
    },
    rejectUnauthorized: TEST_CONFIG.rejectUnauthorized
  }, (res) => {
    let receivedBytes = 0;
    const chunks = [];

    if (mode === 'stream') {
      let streamDone = false;
      let gotFirstByte = false;
      res.on('data', (chunk) => {
        if (!gotFirstByte) {
          gotFirstByte = true;
          const ttft = Date.now() - startTime;
          stats.stream.ttftList.push(ttft);
          if (stats.stream.ttftList.length > 5000) stats.stream.ttftList.shift();
        }
        receivedBytes += chunk.length;
        const text = chunk.toString();
        if (text.includes('event: end') || text.includes('"event":"end"')) {
          streamDone = true;
        }
      });
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        stats.stream.count++;
        stats.stream.totalBytes += receivedBytes;
        stats.stream.totalTime += elapsed;
        recordSuccess(mode, elapsed, receivedBytes);
      });
    } else {
      // 非流式：完整接收
      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        chunks.push(chunk);
      });
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        stats.full.count++;
        stats.full.totalBytes += receivedBytes;
        stats.full.totalTime += elapsed;
        recordSuccess(mode, elapsed, receivedBytes);
      });
    }
  });

  req.on('error', (err) => {
    stats.totalFail++;
    if (isRunning) {
      // 不打印每个错误，太吵，只在首次时提示
    }
  });

  req.on('timeout', () => {
    stats.totalFail++;
    req.destroy();
  });

  req.write(body);
  req.end();
}

function recordSuccess(mode, elapsed, bytes) {
  stats.totalSuccess++;
  stats.windowSuccess++;
  stats.latencies.push(elapsed);
  // 只保留最近 5000 条延迟数据
  if (stats.latencies.length > 5000) stats.latencies.shift();

  // 判断是否可以发下一个请求
  scheduleNext();
}

function scheduleNext() {
  if (!isRunning) return;
  if (TEST_CONFIG.totalRequests > 0 && stats.totalSent >= TEST_CONFIG.totalRequests) return;

  // 维持并发水位：已发送但未完成的 = totalSent - totalSuccess - totalFail
  const inFlight = stats.totalSent - stats.totalSuccess - stats.totalFail;
  if (inFlight < TEST_CONFIG.concurrency) {
    setImmediate(sendRequest);
  } else {
    // 等一个完成后再发（由 recordSuccess 触发 scheduleNext）
  }
}

/*****************************
 *      统计报告              *
 *****************************/
function printReport() {
  const now = Date.now();
  const windowElapsed = (now - stats.windowStart) / 1000;
  const totalElapsed = (now - stats.startTime) / 1000;

  if (windowElapsed < 0.1) return;

  // 窗口 QPS
  const windowQPS = (stats.windowSuccess / windowElapsed).toFixed(1);
  // 全局 QPS
  const globalQPS = stats.totalSuccess > 0
    ? (stats.totalSuccess / totalElapsed).toFixed(1)
    : '0.0';

  // 在途请求数
  const inFlight = stats.totalSent - stats.totalSuccess - stats.totalFail;

  // 延迟百分位
  let p50 = '-', p90 = '-', p99 = '-';
  if (stats.latencies.length > 0) {
    const sorted = [...stats.latencies].sort((a, b) => a - b);
    p50 = sorted[Math.floor(sorted.length * 0.50)] + 'ms';
    p90 = sorted[Math.floor(sorted.length * 0.90)] + 'ms';
    p99 = sorted[Math.floor(sorted.length * 0.99)] + 'ms';
  }

  console.log(`[${formatTime(now)}] `
    + `窗口QPS=${windowQPS}  全局QPS=${globalQPS}  `
    + `成功=${stats.totalSuccess}  失败=${stats.totalFail}  在途=${inFlight}  `
    + `P50=${p50}  P90=${p90}  P99=${p99}`
  );

  // 流式/非流式分别统计
  if (stats.stream.count > 0 || stats.full.count > 0) {
    const streamAvg = stats.stream.count > 0
      ? (stats.stream.totalTime / stats.stream.count).toFixed(0) : '-';
    const fullAvg = stats.full.count > 0
      ? (stats.full.totalTime / stats.full.count).toFixed(0) : '-';
    const streamMB = (stats.stream.totalBytes / 1024 / 1024).toFixed(1);
    const fullMB = (stats.full.totalBytes / 1024 / 1024).toFixed(1);

    let ttftInfo = '';
    if (stats.stream.ttftList.length > 0) {
      const sorted = [...stats.stream.ttftList].sort((a, b) => a - b);
      const avgTtft = (stats.stream.ttftList.reduce((a, b) => a + b, 0) / stats.stream.ttftList.length).toFixed(0);
      ttftInfo = `  TTFT avg=${avgTtft}ms P99=${sorted[Math.floor(sorted.length * 0.99)]}ms`;
    }

    console.log(`  → 流式: ${stats.stream.count}次  平均${streamAvg}ms  ${streamMB}MB${ttftInfo}`);
    console.log(`  → 非流式: ${stats.full.count}次  平均${fullAvg}ms  ${fullMB}MB`);
  }

  // 重置窗口
  stats.windowStart = now;
  stats.windowSent = 0;
  stats.windowSuccess = 0;
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n) {
  return n.toString().padStart(2, '0');
}

/*****************************
 *        启动                *
 *****************************/
console.log('=== 压测客户端启动 ===');
console.log(`目标: https://${TEST_CONFIG.host}:${TEST_CONFIG.port}`);
console.log(`模式: ${TEST_CONFIG.mode}  并发: ${TEST_CONFIG.concurrency}  `
  + `总请求数: ${TEST_CONFIG.totalRequests || '无限'}  输入长度: ${TEST_CONFIG.inputLength}字符`);
console.log('');

// 启动并发请求
for (let i = 0; i < TEST_CONFIG.concurrency; i++) {
  // 错开启动，避免瞬间全部发出
  setTimeout(() => sendRequest(), Math.random() * 500);
}

// 定时打印报告
const reportTimer = setInterval(printReport, TEST_CONFIG.reportInterval * 1000);

// 优雅退出
process.on('SIGINT', () => {
  if (!isRunning) {
    console.log('\n强制退出');
    process.exit(1);
  }

  isRunning = false;
  clearInterval(reportTimer);

  console.log('\n=== 最终统计 ===');
  const totalElapsed = (Date.now() - stats.startTime) / 1000;
  console.log(`运行时间: ${totalElapsed.toFixed(1)}s`);
  console.log(`总请求: ${stats.totalSent}  成功: ${stats.totalSuccess}  失败: ${stats.totalFail}`);
  if (totalElapsed > 0) {
    console.log(`全局 QPS: ${(stats.totalSuccess / totalElapsed).toFixed(1)}`);
  }
  console.log(`流式: ${stats.stream.count}次  非流式: ${stats.full.count}次`);

  if (stats.stream.ttftList.length > 0) {
    const sorted = [...stats.stream.ttftList].sort((a, b) => a - b);
    const avg = (sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(0);
    console.log(`TTFT  avg=${avg}ms  P50=${sorted[Math.floor(sorted.length * 0.50)]}ms  `
      + `P90=${sorted[Math.floor(sorted.length * 0.90)]}ms  P99=${sorted[Math.floor(sorted.length * 0.99)]}ms`);
  }

  if (stats.latencies.length > 0) {
    const sorted = [...stats.latencies].sort((a, b) => a - b);
    console.log(`延迟 P50=${sorted[Math.floor(sorted.length * 0.50)]}ms  `
      + `P90=${sorted[Math.floor(sorted.length * 0.90)]}ms  `
      + `P99=${sorted[Math.floor(sorted.length * 0.99)]}ms  `
      + `Max=${sorted[sorted.length - 1]}ms`);
  }
  console.log('');

  setTimeout(() => process.exit(0), 500);
});
