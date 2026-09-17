import { describe, expect, it } from "vitest";
import { renderDashboard, DASHBOARD_HTML } from "../src/dashboard";

/**
 * 看板的回归测试。
 *
 * 曾经出现过一次线上事故：内联 <script> 里拼接使用说明时，
 * curl 示例的 -d '{"model":...}' 因为单引号嵌套把 JS 字符串提前闭合，
 * 整个脚本变成 SyntaxError，于是 load() 从未执行 ——
 * 表现为页面永远卡在「加载中…」，使用说明也是空的。
 *
 * 这类问题类型检查抓不到（HTML 里的字符串对 tsc 而言只是普通字符），
 * 只有真正把脚本交给 JS 解析器才会暴露，所以这里用 new Function 解析一遍。
 */

/** 取出内联脚本（页面里只有这一个 <script> 块） */
function inlineScript(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m || m[1] === undefined) throw new Error("看板里找不到内联 <script>");
  return m[1];
}

describe("dashboard 内联脚本", () => {
  it("能通过 JS 解析（无语法错误）", () => {
    const js = inlineScript(DASHBOARD_HTML);
    expect(js.length).toBeGreaterThan(1000);
    // 解析（不执行）：语法错误会在这里抛出
    expect(() => new Function(js)).not.toThrow();
  });

  it("renderDashboard 返回的也是合法脚本", async () => {
    const res = renderDashboard();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(() => new Function(inlineScript(html))).not.toThrow();
  });

  it("脚本里不残留未转义的字符串隐患（-d '{...}' 这种嵌套引号）", () => {
    const js = inlineScript(DASHBOARD_HTML);
    // 之前的写法会产生 '-d '{"model"... 这种把字符串提前闭合的片段
    expect(js).not.toMatch(/-d\s*'\{/);
  });

  it("页面包含使用说明和占位符，且由 HTML 提供（不靠 JS 拼字符串）", () => {
    expect(DASHBOARD_HTML).toContain('id="usage"');
    expect(DASHBOARD_HTML).toContain("__BASE__");
    expect(DASHBOARD_HTML).toContain("__TOKEN__");
    // curl 示例确实在 HTML 里
    expect(DASHBOARD_HTML).toContain("/v1/chat/completions");
  });

  it("脚本末尾会调用 load()（否则表格会一直停在加载中）", () => {
    const js = inlineScript(DASHBOARD_HTML);
    expect(js).toMatch(/load\(false\);\s*$/);
  });

  it("render() 出错提前 return 前也会填充使用说明", () => {
    const js = inlineScript(DASHBOARD_HTML);
    // 首次打开页面时没有 token，report.error 会让 render() 提前 return；
    // renderUsage() 必须在那个 return 之前调用，否则用户看到的是 __BASE__ 原始占位符
    const errIdx = js.indexOf("if (d.error)");
    const usageIdx = js.indexOf("renderUsage()", js.indexOf("function render()"));
    expect(errIdx).toBeGreaterThan(-1);
    expect(usageIdx).toBeGreaterThan(-1);
    expect(usageIdx).toBeLessThan(errIdx);
  });

  it("使用说明用 textContent 替换，不用 innerHTML", () => {
    const js = inlineScript(DASHBOARD_HTML);
    expect(js).toMatch(/el\.textContent\s*=/);
    expect(js).not.toMatch(/el\.innerHTML\s*=\s*el\.innerHTML/);
  });

  it("所有 $('id') 引用的元素都真实存在", () => {
    const js = inlineScript(DASHBOARD_HTML);
    const used = new Set(
      [...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1] as string),
    );
    const present = new Set(
      [...DASHBOARD_HTML.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1] as string),
    );
    const missing = [...used].filter((id) => !present.has(id));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(8);
  });
});
