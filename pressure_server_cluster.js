/*****************************
 *        配置区              *
 *****************************/
const CONFIG = {
  // 服务端口
  httpsPort: parseInt(process.env.HTTPS_PORT) || 4000,
  httpPort: parseInt(process.env.HTTP_PORT) || 3000,
  cert: {
    key: process.env.CERT_KEY || './cert/key.pem',
    cert: process.env.CERT_CERT || './cert/cert.pem'
  },

  // CPU 核数（0 = 自动检测使用全部核心）
  workers: 4,

  // 请求体限制
  maxBodyLength: 1024 * 1024, // 1MB

  // 非流式响应固定文本长度（字符数，0 = 按请求体长度 × 随机倍数）
  fixedResponseLength: 64,

  // LLM 延迟模拟
  latency: {
    ttft: 10,     // Time To First Token，首字延迟(ms)
    tpot: 5       // Time Per Output Token，每字间隔(ms)
  },

  // 流式响应配置
  stream: {
    minMultiplier: 1,     // 响应长度最小倍数
    maxMultiplier: 10     // 响应长度最大倍数
  }
};

/*****************************
 *        核心逻辑            *
 *****************************/
const cluster = require('cluster');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');

// 预生成汉字池（避免每次请求重复构建）
const CHAR_POOL = buildCharPool();
// 预生成文本块（复用减少 GC 压力）
const PREGEN_CHUNKS = buildPregenChunks(1024);

function buildCharPool() {
  const pool = [];
  for (let code = 0x4E00; code <= 0x9FFF; code++) pool.push(String.fromCharCode(code));
  for (let code = 0x3400; code <= 0x4DBF; code++) pool.push(String.fromCharCode(code));
  return pool;
}

function buildPregenChunks(chunkSize) {
  const chunks = [];
  for (let i = 0; i < 64; i++) {
    let str = '';
    for (let j = 0; j < chunkSize; j++) {
      str += CHAR_POOL[Math.floor(Math.random() * CHAR_POOL.length)];
    }
    chunks.push(str);
  }
  return chunks;
}

/*****************************
 *      Master 进程           *
 *****************************/
if (cluster.isPrimary) {
  const numWorkers = CONFIG.workers || os.cpus().length;
  console.log(`[Master] PID=${process.pid} 启动 ${numWorkers} 个 Worker`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = cluster.fork();
    console.log(`[Master] Worker ${worker.process.pid} 已启动`);
  }

  cluster.on('exit', (worker, code, signal) => {
    console.warn(`[Master] Worker ${worker.process.pid} 退出 (code=${code}, signal=${signal})，重启中...`);
    const newWorker = cluster.fork();
    console.log(`[Master] Worker ${newWorker.process.pid} 已重启`);
  });

  return; // Master 不启动服务器
}

/*****************************
 *      Worker 进程           *
 *****************************/
const workerId = cluster.worker.id;
console.log(`[Worker ${workerId}] PID=${process.pid} 初始化`);

// 检测证书是否可用
let httpsEnabled = false;
let httpsServer = null;
try {
  fs.accessSync(CONFIG.cert.key, fs.constants.R_OK);
  fs.accessSync(CONFIG.cert.cert, fs.constants.R_OK);
  httpsEnabled = true;
} catch (e) {
  // Worker 0 输出 warning，其余静默
  if (workerId === 1) {
    console.warn(`[WARNING] 证书文件不可用 (${CONFIG.cert.key} 或 ${CONFIG.cert.cert})，仅启动 HTTP 模式`);
  }
}

if (httpsEnabled) {
  httpsServer = https.createServer({
    key: fs.readFileSync(CONFIG.cert.key),
    cert: fs.readFileSync(CONFIG.cert.cert)
  }, (req, res) => handleRequest(req, res, true));
}

// HTTP 服务器：有证书时做重定向，无证书时直接处理业务
const httpServer = http.createServer((req, res) => {
  if (httpsEnabled) {
    res.writeHead(301, {
      Location: `https://${req.headers.host.replace(/:\d+$/, '')}:${CONFIG.httpsPort}${req.url}`
    });
    res.end();
  } else {
    handleRequest(req, res, false);
  }
});

/*****************************
 *      请求体收集器           *
 *****************************/
class BodyCollector {
  constructor(maxLength) {
    this.chunks = [];
    this.length = 0;
    this.maxLength = maxLength;
    this.isTruncated = false;
  }

  append(chunk) {
    if (this.isTruncated) return;

    const remaining = this.maxLength - this.length;
    if (remaining <= 0) {
      this.isTruncated = true;
      return;
    }

    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.length += chunk.length;
    } else {
      this.chunks.push(chunk.slice(0, remaining));
      this.length += remaining;
      this.isTruncated = true;
    }
  }

  getResult() {
    return {
      body: Buffer.concat(this.chunks, this.length).toString(),
      isTruncated: this.isTruncated
    };
  }
}

/*****************************
 *      请求处理主逻辑         *
 *****************************/
async function handleRequest(req, res, isHttps) {
  const clientIp = req.socket.remoteAddress.replace(/^::ffff:/, '');

  // 仅接受 POST
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('Method Not Allowed');
  }

  // 收集请求体
  const collector = new BodyCollector(CONFIG.maxBodyLength);
  await new Promise(resolve => {
    req.on('data', chunk => collector.append(chunk));
    req.on('end', resolve);
  });

  const { body, isTruncated } = collector.getResult();

  // 路由分发
  if (req.url === '/deepseek-r1-tx/v1/chat') {
    handleStreamResponse(res, body.length, isTruncated);
  } else if (req.url === '/deepseek-r1-tx/v1/chat/completions') {
    handleFullResponse(res, body.length, isTruncated);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}

/*****************************
 *      流式响应              *
 *****************************/
function handleStreamResponse(res, reqLength, isTruncated) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁止 nginx 缓冲

  const baseLength = Math.max(10, reqLength);
  const totalChars = Math.floor(
    baseLength * (CONFIG.stream.minMultiplier + Math.random() * (CONFIG.stream.maxMultiplier - CONFIG.stream.minMultiplier))
  );
  const streamId = `stream_${Date.now()}_${workerId}`;

  // TTFT 阶段：模拟 prefill 延迟，之后再发首字
  setTimeout(() => {
    // 发送初始元数据（首字到达时客户端才能收到）
    res.write(`event: init\ndata: ${JSON.stringify({
      id: streamId,
      total: totalChars,
      truncated: isTruncated
    })}\n\n`);

    let sent = 0;

    const sendNext = () => {
      // 检查连接是否已关闭
      if (res.writableEnded || res.destroyed) return;

      if (sent >= totalChars) {
        res.write(`event: end\ndata: {"id": "${streamId}"}\n\n`);
        res.end();
        return;
      }

      const char = CHAR_POOL[Math.floor(Math.random() * CHAR_POOL.length)];
      const canWrite = res.write(`data: ${JSON.stringify({
        id: streamId,
        index: sent,
        data: char,
        truncated: isTruncated
      })}\n\n`);

      sent++;

      // TPOT 阶段：每个 token 的间隔
      if (canWrite) {
        setTimeout(sendNext, CONFIG.latency.tpot);
      } else {
        res.once('drain', () => setTimeout(sendNext, CONFIG.latency.tpot));
      }
    };

    // 首字立即发出（TTFT 已在 setTimeout 层面等待过）
    sendNext();
  }, CONFIG.latency.ttft);
}

/*****************************
 *      非流式响应            *
 *****************************/
function handleFullResponse(res, reqLength, isTruncated) {
  let responseLength;

  if (CONFIG.fixedResponseLength > 0) {
    responseLength = CONFIG.fixedResponseLength;
  } else {
    const baseLength = Math.max(10, reqLength);
    responseLength = Math.floor(
      baseLength * (CONFIG.stream.minMultiplier + Math.random() * (CONFIG.stream.maxMultiplier - CONFIG.stream.minMultiplier))
    );
  }

  // 预构建响应内容
  const content = buildResponseText(responseLength);

  const response = {
    content,
    meta: {
      request_length: reqLength,
      response_length: responseLength,
      truncated: isTruncated
    }
  };

  const payload = Buffer.from(JSON.stringify(response), 'utf-8');

  // 模拟 TTFT：非流式也需要服务端处理时间
  // 总延迟 = TTFT + TPOT × token数（模拟完整生成后一次性返回）
  const totalDelay = CONFIG.latency.ttft + CONFIG.latency.tpot * responseLength;
  const clampedDelay = Math.min(totalDelay, 30000); // 上限 30s

  setTimeout(() => {
    if (res.writableEnded || res.destroyed) return;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', payload.length);
    res.setHeader('X-Request-Truncated', isTruncated.toString());
    res.end(payload);
  }, clampedDelay);
}

/**
 * 从预生成块高效拼接响应文本
 */
function buildResponseText(length) {
  if (length === 0) return '';

  const chunkSize = PREGEN_CHUNKS[0].length;
  const fullChunks = Math.floor(length / chunkSize);
  const remainder = length % chunkSize;

  const parts = [];
  for (let i = 0; i < fullChunks; i++) {
    parts.push(PREGEN_CHUNKS[i % PREGEN_CHUNKS.length]);
  }
  if (remainder > 0) {
    // 从随机预生成块中截取
    const src = PREGEN_CHUNKS[Math.floor(Math.random() * PREGEN_CHUNKS.length)];
    parts.push(src.slice(0, remainder));
  }
  return parts.join('');
}

/*****************************
 *        启动服务            *
 *****************************/
if (httpsEnabled && httpsServer) {
  httpsServer.listen(CONFIG.httpsPort, () => {
    console.log(`[Worker ${workerId}] HTTPS 运行在 ${CONFIG.httpsPort} 端口`);
  });
}

httpServer.listen(CONFIG.httpPort, () => {
  if (httpsEnabled) {
    console.log(`[Worker ${workerId}] HTTP 重定向运行在 ${CONFIG.httpPort} 端口`);
  } else {
    console.log(`[Worker ${workerId}] HTTP 运行在 ${CONFIG.httpPort} 端口 (无证书模式)`);
  }
});

// Worker 全局异常处理
process.on('uncaughtException', (err) => {
  console.error(`[Worker ${workerId}] 全局异常:`, err);
});
