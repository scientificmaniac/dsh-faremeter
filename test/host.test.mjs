/**
 * 宿主半边测试：路由注册、回环校验、方法限制、首次扫描后的 JSON 形状。
 *
 * 用假 ctx 驱动真实的 `lib/index.js`，不启动 http 服务器。
 */
import { apply } from "../lib/index.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") throw new Error("请用 asyncTest");
    passed += 1;
  } catch (error) {
    failures.push(`${name}\n      ${error && error.message ? error.message : String(error)}`);
  }
}
const asyncTests = [];
function asyncTest(name, fn) {
  asyncTests.push([name, fn]);
}
function ok(condition, message) {
  if (!condition) throw new Error(message);
}
function eq(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label || "值"}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** 造一个假 ctx，收集路由与清理函数。 */
function createFakeCtx() {
  const routes = [];
  const cleanups = [];
  const logs = [];
  const ctx = {
    logger: () => ({ info: (message) => logs.push(String(message)) }),
    inject: (deps, callback) => {
      ok(Array.isArray(deps), "inject 参数应是数组");
      callback({ webServer: { register: (route) => { routes.push(route); return { dispose() {} }; } } });
    },
    get: (name) => (name === "workspaceRegistry" ? null : undefined),
    effect: (fn) => {
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.push(cleanup);
      return () => {};
    }
  };
  return { ctx, routes, cleanups, logs };
}

/** 造一个假 req/res 对，返回 { status, headers, body }。 */
function callHandler(route, { method = "GET", host = "127.0.0.1:43120" } = {}) {
  return new Promise((resolve) => {
    const result = { status: 0, headers: {}, body: "" };
    const res = {
      writeHead(status, headers) {
        result.status = status;
        result.headers = headers || {};
      },
      end(chunk) {
        result.body = chunk === undefined ? "" : String(chunk);
        resolve(result);
      }
    };
    const req = { method, headers: { host } };
    Promise.resolve(route.handler(req, res)).catch((error) => {
      result.status = 500;
      result.body = String(error);
      resolve(result);
    });
  });
}

const fake = createFakeCtx();
apply(fake.ctx);

test("apply：注册 GET /faremeter/summary（exact）", () => {
  eq(fake.routes.length, 1, "应注册一条路由");
  eq(fake.routes[0].kind, "exact");
  eq(fake.routes[0].path, "/faremeter/summary");
  eq(typeof fake.routes[0].handler, "function");
  ok(fake.logs.some((line) => line.includes("账本路由已挂载")), "应有挂载日志");
});

test("apply：重复 apply / slots 异常都不抛错", () => {
  const original = console.error;
  console.error = () => {};
  try {
    apply({ inject: () => { throw new Error("boom"); }, get: () => undefined });
  } finally {
    console.error = original;
  }
});

asyncTest("路由：非回环 Host 一律 403", async () => {
  const response = await callHandler(fake.routes[0], { host: "evil.example.com" });
  eq(response.status, 403);
  ok(response.body.includes("loopback"), "应说明只允许回环");
});

asyncTest("路由：非 GET 方法 405", async () => {
  const response = await callHandler(fake.routes[0], { method: "POST" });
  eq(response.status, 405);
});

asyncTest("路由：回环 GET 返回 JSON 且首次扫描后形状完整", async () => {
  // 等首次扫描（apply 里延迟 1200ms 启动）
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const response = await callHandler(fake.routes[0], { host: "127.0.0.1:43120" });
  eq(response.status, 200);
  eq(response.headers["Content-Type"], "application/json; charset=utf-8");
  eq(response.headers["Cache-Control"], "no-store");
  const body = JSON.parse(response.body);
  ok(typeof body.total === "number", "应有 total");
  ok(body.sessions && typeof body.sessions === "object", "应有 sessions");
  ok(body.workspaces && typeof body.workspaces === "object", "应有 workspaces");
  ok(body.byWorkspaceId && typeof body.byWorkspaceId === "object", "应有 byWorkspaceId");
  ok(typeof body.updatedAt === "number", "应有 updatedAt");
  ok(typeof body.webUnits === "number", "应有 webUnits（Search/Fetch 汇总）");
  ok(body.files > 0, `应扫到本机会话（实际 ${body.files}），若本机没有会话日志这条可为 0`);
  // 三种口径自洽
  const workspaceSum = Object.values(body.workspaces).reduce((sum, bucket) => sum + bucket.units, 0);
  const sessionSum = Object.values(body.sessions).reduce((sum, entry) => sum + entry.units, 0);
  eq(workspaceSum, body.total, "工作区求和应等于 total");
  eq(sessionSum, body.total, "会话求和应等于 total");
  // Search/Fetch 口径自洽 + 分桶字段齐全
  const sessionWebSum = Object.values(body.sessions).reduce((sum, entry) => sum + (entry.webUnits || 0), 0);
  eq(sessionWebSum, body.webUnits, "会话 web 求和应等于 webUnits");
  for (const bucket of Object.values(body.workspaces)) {
    ok(typeof bucket.webUnits === "number", "工作区分桶应带 webUnits");
    ok(typeof bucket.searchRequests === "number" && typeof bucket.fetchRequests === "number", "工作区分桶应带 search/fetch 次数");
  }
});

asyncTest("路由：HEAD 也返回 200（不写 body）", async () => {
  const response = await callHandler(fake.routes[0], { method: "HEAD" });
  eq(response.status, 200);
});

await (async () => {
  for (const [name, fn] of asyncTests) {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failures.push(`${name}\n      ${error && error.message ? error.message : String(error)}`);
    }
  }
})();

for (const cleanup of fake.cleanups) {
  try { cleanup(); } catch (error) { /* 忽略 */ }
}

const total = passed + failures.length;
console.log(`\n宿主半边测试：${passed}/${total} 通过`);
if (failures.length > 0) {
  console.error("\n失败项：");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
}
process.exit(failures.length > 0 ? 1 : 0);
