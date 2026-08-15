import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Skill Observatory shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Skill Observatory · 技能看台<\/title>/i);
  assert.match(html, /技能看台/);
  assert.match(html, /任务匹配器/);
  assert.match(html, /Skill 清单/);
  assert.match(html, /本机私有/);
  for (const label of ["已安装", "历史用过", "本月使用", "需配置", "异常", "使用记录", "状态", "分类", "来源", "排序"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /最多 3 个/);
  assert.match(html, /隐式匹配不是百分之百保证/);
  assert.doesNotMatch(html, /在 GitHub 查找/);
  assert.doesNotMatch(html, /自动安装|立即安装/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/i);
});
