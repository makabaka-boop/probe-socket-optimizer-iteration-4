import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { NoPerfectAssignmentError } from './hungarian.js';
import { analyzeMandatoryPairs } from './mandatory.js';
import { solveMigration } from './migration.js';
import { validateCosts, validateReference } from './validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 25 * 1024 * 1024, // n=400 的 JSON 约 20MB
  });

  // JSON 语法错误等请求类错误统一为 422 / INVALID_INPUT。
  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.status(422).send({
        status: 'error',
        error: 'INVALID_INPUT',
        message: error.message,
      });
    }
    request.log.error(error);
    return reply.status(500).send({
      status: 'error',
      error: 'INTERNAL_ERROR',
      message: error.message,
    });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.post('/api/solve', async (request, reply) => {
    const result = validateCosts(request.body);
    if (!result.ok) {
      return reply.status(422).send({
        status: 'error',
        error: 'INVALID_INPUT',
        message: result.reason,
      });
    }
    const n = result.n;

    // 迁移模式：请求显式携带 reference 字段时启用。
    // 参考的规模/排列/字段非法在“求解前”整批拒绝（422），即使矩阵本身可解也不求解；
    // 参考边是否仍允许不在此校验——禁配边上的旧配对只用于计变更行数。
    // 完全不带 reference 的旧版请求走原路径，响应结构一字不变。
    let reference = null;
    const hasReference =
      request.body !== null &&
      typeof request.body === 'object' &&
      Object.prototype.hasOwnProperty.call(request.body, 'reference');
    if (hasReference) {
      const refResult = validateReference(request.body.reference, n);
      if (!refResult.ok) {
        return reply.status(422).send({
          status: 'error',
          error: 'INVALID_INPUT',
          message: refResult.reason,
        });
      }
      reference = refResult.reference;
    }

    try {
      if (reference) {
        // 迁移求解：先最小化新矩阵总成本，再在同成本完美匹配中最小化相对参考的变更行数。
        // 两级目标独立求解，不用放大系数合并；标记针对新展示配对重新分析。
        const { assignment, totalCost, pairFlags, changedRows, changedCount } = solveMigration(
          request.body.costs,
          reference
        );
        return reply.send({
          status: 'ok',
          n,
          assignment,
          totalCost,
          pairFlags,
          reference: reference.slice(), // 回显归一化参考，供页面核对结果归属
          changedRows,
          changedCount,
        });
      }

      // 同一次求解内完成最优匹配与必然连线分析：求解器可任选一个最优配对，
      // pairFlags 严格对应下方返回（即页面展示）的这一组配对。
      const { assignment, totalCost, pairFlags } = analyzeMandatoryPairs(request.body.costs);
      return reply.send({
        status: 'ok',
        n: result.n,
        assignment, // assignment[i] = 第 i 行（探针）匹配的列（测试座），0 基下标
        totalCost, // 精确整数，可由 assignment 对原矩阵直接复算
        // 与 assignment 逐行对齐：forced=该连线出现在所有最优完美匹配中；
        // alternatives=该探针在最优解中可改配的其他列数（forced 时为 0）。
        pairFlags,
      });
    } catch (err) {
      if (err instanceof NoPerfectAssignmentError) {
        return reply.status(409).send({
          status: 'error',
          error: 'NO_PERFECT_ASSIGNMENT',
          message: '禁配关系下不存在覆盖全部探针与测试座的完美匹配',
        });
      }
      throw err;
    }
  });

  // 生产环境托管 Vite 构建产物。
  if (existsSync(DIST_DIR)) {
    await app.register(fastifyStatic, { root: DIST_DIR });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url && request.raw.url.startsWith('/api/')) {
        return reply.status(404).send({
          status: 'error',
          error: 'NOT_FOUND',
          message: '接口不存在',
        });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildServer()
    .then((app) => app.listen({ port: PORT, host: HOST }))
    .then((address) => {
      console.log(`探针分配服务已启动: ${address}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
