/*****************************
 *        测试配置区           *
 *****************************/
const TEST_CONFIG = {
  host: '127.0.0.1',
  port: 4000,
  mode: 'mixed',
  concurrency: 100,
  workers: 0,
  totalRequests: 0,
  duration: 300,             // 测试时长（秒），0=无限
  inputLength: 100,
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
      case '--workers':
      case '-w':             TEST_CONFIG.workers = parseInt(args[++i]); break;
      case '--requests':
      case '-n':             TEST_CONFIG.totalRequests = parseInt(args[++i]); break;
      case '--input':
      case '-i':             TEST_CONFIG.inputLength = parseInt(args[++i]); break;
      case '--interval':     TEST_CONFIG.reportInterval = parseInt(args[++i]); break;
      case '--duration':
      case '-d':             TEST_CONFIG.duration = parseInt(args[++i]); break;
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
  --mode <mode>       stream | full | mixed (默认: mixed)
  -c, --concurrency   每 Worker 并发数 (默认: 100)
  -w, --workers       Worker 数，0=全部核心 (默认: 0)
  -n, --requests      总请求数，0=无限 (默认: 0)
  -d, --duration      测试时长（秒），到时间自动结束 (默认: 300)
  -i, --input         输入文本长度 (默认: 100)
  --interval <sec>    统计间隔 (默认: 3)
  -h, --help          显示帮助

示例:
  node pressure_client.js -w 4 -c 200 -n 1000 -i 500 --mode stream
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
const cluster = require('cluster');
const https = require('https');
const http = require('http');
const os = require('os');

parseArgs();

const numWorkers = TEST_CONFIG.workers || os.cpus().length;
const useHttps = TEST_CONFIG.port === 443;
const requestFn = useHttps ? https.request : http.request;

/*****************************
 *      Master 进程           *
 *****************************/
if (cluster.isPrimary) {
  console.log('=== 压测客户端启动 (多核) ===');
  console.log(`目标: http${useHttps ? 's' : ''}://${TEST_CONFIG.host}:${TEST_CONFIG.port}`);
  console.log(`Workers: ${numWorkers}  每 Worker 并发: ${TEST_CONFIG.concurrency}  `
    + `总并发: ${numWorkers * TEST_CONFIG.concurrency}`);
  console.log(`模式: ${TEST_CONFIG.mode}  总请求数: ${TEST_CONFIG.totalRequests || '无限'}  `
    + `输入长度: ${TEST_CONFIG.inputLength}字符`);
  console.log('');

  const startTime = Date.now();

  // 每个 Worker 最新的统计快照
  const snapshots = {};
  let prevTotalSuccess = 0;

  const perWorkerRequests = TEST_CONFIG.totalRequests > 0
    ? Math.ceil(TEST_CONFIG.totalRequests / numWorkers) : 0;

  for (let i = 0; i < numWorkers; i++) {
    const worker = cluster.fork();

    worker.on('message', (msg) => {
      // 直接用 Worker 上报的快照覆盖
      if (msg.type === 'report') {
        snapshots[worker.id] = msg.data;
      }
    });

    // 通知 Worker 开始
    worker.send({
      type: 'start',
      workerIndex: i,
      requests: perWorkerRequests
    });
  }

  // 定时打印报告
  setInterval(() => {
    const now = Date.now();
    const totalElapsed = (now - startTime) / 1000;

    // 聚合所有 Worker 快照
    let agg = { success: 0, fail: 0,
      stream: { count: 0, totalBytes: 0, totalTime: 0 },
      full: { count: 0, totalBytes: 0, totalTime: 0 },
      latencies: [], ttftList: [] };

    for (const id in snapshots) {
      const s = snapshots[id];
      agg.success += s.success;
      agg.fail += s.fail;
      agg.stream.count += s.stream.count;
      agg.stream.totalBytes += s.stream.totalBytes;
      agg.stream.totalTime += s.stream.totalTime;
      agg.full.count += s.full.count;
      agg.full.totalBytes += s.full.totalBytes;
      agg.full.totalTime += s.full.totalTime;
      if (s.latencies) agg.latencies = agg.latencies.concat(s.latencies.slice(-100));
      if (s.ttftList) agg.ttftList = agg.ttftList.concat(s.ttftList.slice(-100));
    }

    const windowSuccess = agg.success - prevTotalSuccess;
    prevTotalSuccess = agg.success;

    const windowQPS = totalElapsed > 0.1 ? (windowSuccess / TEST_CONFIG.reportInterval).toFixed(1) : '0.0';
    const globalQPS = agg.success > 0 ? (agg.success / totalElapsed).toFixed(1) : '0.0';

    let p50 = '-', p90 = '-', p99 = '-';
    if (agg.latencies.length > 0) {
      const sorted = agg.latencies.sort((a, b) => a - b);
      p50 = sorted[Math.floor(sorted.length * 0.50)] + 'ms';
      p90 = sorted[Math.floor(sorted.length * 0.90)] + 'ms';
      p99 = sorted[Math.floor(sorted.length * 0.99)] + 'ms';
    }

    console.log(`[${fmtTime(now)}] `
      + `窗口QPS=${windowQPS}  全局QPS=${globalQPS}  `
      + `成功=${agg.success}  失败=${agg.fail}  `
      + `P50=${p50}  P90=${p90}  P99=${p99}`
    );

    if (agg.stream.count > 0 || agg.full.count > 0) {
      const sAvg = agg.stream.count > 0 ? (agg.stream.totalTime / agg.stream.count).toFixed(0) : '-';
      const fAvg = agg.full.count > 0 ? (agg.full.totalTime / agg.full.count).toFixed(0) : '-';
      const sMB = (agg.stream.totalBytes / 1048576).toFixed(1);
      const fMB = (agg.full.totalBytes / 1048576).toFixed(1);

      let ttftInfo = '';
      if (agg.ttftList.length > 0) {
        const st = agg.ttftList.sort((a, b) => a - b);
        const avg = (st.reduce((a, b) => a + b, 0) / st.length).toFixed(0);
        ttftInfo = `  TTFT avg=${avg}ms P99=${st[Math.floor(st.length * 0.99)]}ms`;
      }

      console.log(`  → 流式: ${agg.stream.count}次  平均${sAvg}ms  ${sMB}MB${ttftInfo}`);
      console.log(`  → 非流式: ${agg.full.count}次  平均${fAvg}ms  ${fMB}MB`);
    }
  }, TEST_CONFIG.reportInterval * 1000);

  // 定时器：到时间自动结束
  if (TEST_CONFIG.duration > 0) {
    setTimeout(() => {
      console.log(`\n=== 测试时长 ${TEST_CONFIG.duration}s 已到，结束测试 ===`);
      // 通知所有 Worker 停止
      for (const id in cluster.workers) {
        cluster.workers[id].send({ type: 'stop' });
      }
      // 等待 Worker 上报最终数据
      setTimeout(() => {
        process.emit('SIGINT');
      }, 2000);
    }, TEST_CONFIG.duration * 1000);
  }

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\n=== 最终统计 ===');
    const totalElapsed = (Date.now() - startTime) / 1000;

    let agg = { success: 0, fail: 0,
      stream: { count: 0, totalTime: 0 }, full: { count: 0, totalTime: 0 },
      latencies: [], ttftList: [] };

    for (const id in snapshots) {
      const s = snapshots[id];
      agg.success += s.success;
      agg.fail += s.fail;
      agg.stream.count += s.stream.count;
      agg.stream.totalTime += s.stream.totalTime;
      agg.full.count += s.full.count;
      agg.full.totalTime += s.full.totalTime;
      if (s.latencies) agg.latencies = agg.latencies.concat(s.latencies);
      if (s.ttftList) agg.ttftList = agg.ttftList.concat(s.ttftList);
    }

    console.log(`运行时间: ${totalElapsed.toFixed(1)}s`);
    console.log(`总请求: ${agg.success + agg.fail}  成功: ${agg.success}  失败: ${agg.fail}`);
    if (totalElapsed > 0) console.log(`全局 QPS: ${(agg.success / totalElapsed).toFixed(1)}`);
    console.log(`流式: ${agg.stream.count}次  非流式: ${agg.full.count}次`);

    if (agg.ttftList.length > 0) {
      const sorted = agg.ttftList.sort((a, b) => a - b);
      console.log(`TTFT  avg=${(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(0)}ms  `
        + `P50=${sorted[Math.floor(sorted.length * 0.50)]}ms  `
        + `P90=${sorted[Math.floor(sorted.length * 0.90)]}ms  `
        + `P99=${sorted[Math.floor(sorted.length * 0.99)]}ms`);
    }
    if (agg.latencies.length > 0) {
      const sorted = agg.latencies.sort((a, b) => a - b);
      console.log(`延迟 P50=${sorted[Math.floor(sorted.length * 0.50)]}ms  `
        + `P90=${sorted[Math.floor(sorted.length * 0.90)]}ms  `
        + `P99=${sorted[Math.floor(sorted.length * 0.99)]}ms  `
        + `Max=${sorted[sorted.length - 1]}ms`);
    }

    for (const id in cluster.workers) cluster.workers[id].kill();
    process.exit(0);
  });

  return;
}

/*****************************
 *      Worker 进程           *
 *****************************/
const workerId = cluster.worker.id;
let myTotalRequests = 0;
let isRunning = true;
let sent = 0;

const stats = {
  success: 0,
  fail: 0,
  stream: { count: 0, totalBytes: 0, totalTime: 0 },
  full: { count: 0, totalBytes: 0, totalTime: 0 },
  latencies: [],
  ttftList: []
};

// 等待 Master 分配任务
process.on('message', (msg) => {
  if (msg.type === 'start') {
    myTotalRequests = msg.requests;

    const requestBody = generateRequestBody(TEST_CONFIG.inputLength);
    if (workerId === 1) {
      console.log(`[Worker] 输入文本: ${TEST_CONFIG.inputLength} 字符 / ${Buffer.byteLength(requestBody, 'utf-8')} 字节`);
    }

    // 启动并发
    for (let i = 0; i < TEST_CONFIG.concurrency; i++) {
      setTimeout(() => sendRequest(requestBody), Math.random() * 200);
    }
  }
  if (msg.type === 'stop') {
    isRunning = false;
    // 上报最终数据
    process.send({
      type: 'report',
      data: {
        success: stats.success,
        fail: stats.fail,
        stream: { count: stats.stream.count, totalBytes: stats.stream.totalBytes, totalTime: stats.stream.totalTime },
        full: { count: stats.full.count, totalBytes: stats.full.totalBytes, totalTime: stats.full.totalTime },
        latencies: stats.latencies.slice(-500),
        ttftList: stats.ttftList.slice(-500)
      }
    });
  }
});

// 定时上报统计给 Master
setInterval(() => {
  process.send({
    type: 'report',
    data: {
      success: stats.success,
      fail: stats.fail,
      stream: { count: stats.stream.count, totalBytes: stats.stream.totalBytes, totalTime: stats.stream.totalTime },
      full: { count: stats.full.count, totalBytes: stats.full.totalBytes, totalTime: stats.full.totalTime },
      latencies: stats.latencies.slice(-200),
      ttftList: stats.ttftList.slice(-200)
    }
  });
}, 1000);  // 每秒上报一次

function sendRequest(requestBody) {
  if (!isRunning) return;

  sent++;

  const mode = TEST_CONFIG.mode === 'mixed'
    ? (Math.random() < 0.5 ? 'stream' : 'full')
    : TEST_CONFIG.mode;

  const path = mode === 'stream'
    ? '/deepseek-r1-tx/v1/chat'
    : '/deepseek-r1-tx/v1/chat/completions';

  const body = Buffer.from(requestBody, 'utf-8');
  const startTime = Date.now();

  const req = requestFn({
    hostname: TEST_CONFIG.host,
    port: TEST_CONFIG.port,
    path,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    rejectUnauthorized: useHttps ? TEST_CONFIG.rejectUnauthorized : undefined
  }, (res) => {
    let receivedBytes = 0;

    if (mode === 'stream') {
      let gotFirstByte = false;
      res.on('data', (chunk) => {
        if (!gotFirstByte) {
          gotFirstByte = true;
          stats.ttftList.push(Date.now() - startTime);
          if (stats.ttftList.length > 5000) stats.ttftList.shift();
        }
        receivedBytes += chunk.length;
      });
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        stats.stream.count++;
        stats.stream.totalBytes += receivedBytes;
        stats.stream.totalTime += elapsed;
        stats.success++;
        stats.latencies.push(elapsed);
        if (stats.latencies.length > 5000) stats.latencies.shift();
        scheduleNext(requestBody);
      });
    } else {
      res.on('data', (chunk) => { receivedBytes += chunk.length; });
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        stats.full.count++;
        stats.full.totalBytes += receivedBytes;
        stats.full.totalTime += elapsed;
        stats.success++;
        stats.latencies.push(elapsed);
        if (stats.latencies.length > 5000) stats.latencies.shift();
        scheduleNext(requestBody);
      });
    }
  });

  req.on('error', () => { stats.fail++; scheduleNext(requestBody); });
  req.on('timeout', () => { stats.fail++; req.destroy(); });
  req.write(body);
  req.end();
}

function scheduleNext(requestBody) {
  if (!isRunning) return;

  const inFlight = sent - stats.success - stats.fail;
  if (inFlight < TEST_CONFIG.concurrency) {
    setImmediate(() => sendRequest(requestBody));
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
