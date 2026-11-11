import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 包契约回归：本仓库是独立维护的 fork，不再位于上游 monorepo，也不由
// magpie-community/plugins 的 registry.json 收录。这里只校验 magpie 宿主安装所依赖的
// 字段，以及 README 里的 fork 来源说明，全程只读本仓库内的文件。
type Pkg = {
  name: string;
  main?: string;
  files: string[];
  keywords: string[];
};

const pkgDir = join(import.meta.dir, "..");
const pkg: Pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Pkg;
const readme = readFileSync(join(pkgDir, "README.md"), "utf8");

describe("包契约（magpie 宿主安装约定）", () => {
  test("包名与入口", () => {
    expect(pkg.name).toBe("magpie-window-warmup-plus");
    expect(pkg.main === undefined || existsSync(join(pkgDir, pkg.main))).toBe(true);
  });

  test("files 只列发布必需的文件，且包含 dist 与 page", () => {
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("page");
    for (const f of pkg.files) expect(["dist", "page", "README.md", "LICENSE"]).toContain(f);
  });

  test("keywords 保留插件发现契约词", () => {
    for (const w of ["magpie", "magpie-page", "magpie-plugin"]) {
      expect(pkg.keywords, `keywords 缺「${w}」`).toContain(w);
    }
  });

  test("README 说明 fork 来源", () => {
    expect(readme).toContain("magpie-community/plugins");
  });
});
