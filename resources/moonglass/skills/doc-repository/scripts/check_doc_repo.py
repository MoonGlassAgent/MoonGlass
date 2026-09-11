#!/usr/bin/env python3
"""MoonGlass 文档库、阶段和需求追溯校验器。"""
import argparse, json, re, subprocess, sys
from dataclasses import asdict, dataclass
from datetime import datetime
from fnmatch import fnmatch
from pathlib import Path

STAGES = ("req_spec", "arch", "rtl", "verif", "qa", "synth")
ALIASES = {"req": "req_spec", "requirements": "req_spec", "architecture": "arch", "verification": "verif"}
ORDER = {stage: i for i, stage in enumerate(STAGES)}
DIRS = {"docs": "req_spec", "docs/01_project": "req_spec", "docs/02_requirements": "req_spec",
        "docs/03_design": "arch", "rtl": "rtl", "docs/04_verification": "verif",
        "docs/06_validation": "qa", "docs/05_implementation": "synth", "scripts": "req_spec"}
DOCS = {
    "docs/01_project/project_charter.md": ("项目章程", "req_spec", True),
    "docs/02_requirements/product_requirements.md": ("产品需求", "req_spec", True),
    "docs/02_requirements/module_specification.md": ("模块规格", "req_spec", True),
    "docs/02_requirements/requirements_traceability.md": ("需求-规格追溯矩阵", "req_spec", True),
    "docs/03_design/architecture.md": ("架构设计", "arch", True),
    "docs/03_design/interface_spec.md": ("接口规格", "arch", True),
    "docs/03_design/microarchitecture.md": ("微架构设计", "arch", False),
    "docs/03_design/clock_reset.md": ("时钟复位设计", "arch", False),
    "docs/04_verification/verification_plan.md": ("验证计划", "verif", True),
    "docs/04_verification/test_plan.md": ("测试计划", "verif", True),
    "docs/04_verification/coverage_plan.md": ("覆盖率计划", "verif", True),
}
IGNORES = ("templates/**", "**/.gitkeep", "**/__pycache__/**", "**/*.pyc")
ALLOWED = {".md", ".png", ".jpg", ".jpeg", ".svg", ".pdf", ".csv", ".json", ".yaml", ".yml"}
STATES = {"草稿", "冻结", "验证", "已验证", "已验收", "开放", "关闭", "draft", "frozen", "verified", "accepted", "open", "closed"}
# 粗筛“形如 ID”的 token，用于发现追溯矩阵单元格中缺失或写错命名空间前缀的写法
COARSE_ID = re.compile(r"[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9-]*\d+")

@dataclass
class Result:
    passed: bool
    category: str
    item: str
    message: str
    severity: str

def safe(value):
    if isinstance(value, str): return value.encode("utf-8", "replace").decode("utf-8")
    if isinstance(value, list): return [safe(v) for v in value]
    if isinstance(value, dict): return {safe(k): safe(v) for k, v in value.items()}
    return value

def cells(line): return [v.strip() for v in line.strip().strip("|").split("|")]

def tables(text):
    lines, found, i = text.splitlines(), [], 0
    while i + 1 < len(lines):
        head, sep = cells(lines[i]), cells(lines[i + 1])
        if len(head) >= 2 and len(head) == len(sep) and all(re.fullmatch(r":?-{3,}:?", v.replace(" ", "")) for v in sep):
            rows, i = [], i + 2
            while i < len(lines) and "|" in lines[i]:
                row = cells(lines[i])
                if len(row) == len(head): rows.append(row)
                i += 1
            found.append((head, rows)); continue
        i += 1
    return found

def ids(text, namespace):
    """展开 REQ-FUNC-001~003、SPEC-IF-001/002 等引用。"""
    found = set()
    pattern = re.compile(rf"\b(?P<p>{namespace}-[A-Z][A-Z0-9_-]*?-)(?P<n>\d+)(?P<t>(?:\s*(?:~|～|\.\.|至|/)\s*\d+)*)", re.I)
    for match in pattern.finditer(text):
        prefix, first, tail = match.group("p").upper(), match.group("n"), match.group("t")
        width, numbers = len(first), [int(first)]
        for op, raw in re.findall(r"(~|～|\.\.|至|/)\s*(\d+)", tail):
            value = int(raw)
            if op == "/": numbers.append(value)
            else:
                step = 1 if value >= numbers[-1] else -1
                numbers.extend(range(numbers[-1] + step, value + step, step))
        found |= {f"{prefix}{n:0{width}d}" for n in numbers}
    return found

def definitions(text, namespace):
    found = set()
    for line in text.splitlines():
        if re.match(r"^#{1,6}\s+", line): found |= ids(line, namespace)
    names = ("需求", "requirement", "req") if namespace == "REQ" else ("规格", "specification", "spec")
    header = re.compile(rf"^(?:{'|'.join(names)})\s*(?:id|编号)$", re.I)
    for heads, rows in tables(text):
        for column, value in enumerate(heads):
            if header.match(value.strip()):
                for row in rows: found |= ids(row[column], namespace)
    return found

class Validator:
    def __init__(self, root, stage, trace=True):
        self.root, self.stage, self.trace = Path(root).resolve(), ALIASES.get(stage, stage), trace
        self.results, self.ignores = [], list(IGNORES)
        custom = self.root / ".check_doc_repo_ignore"
        if custom.exists(): self.ignores += [v.strip() for v in custom.read_text("utf-8", errors="replace").splitlines() if v.strip() and not v.lstrip().startswith("#")]

    def add(self, severity, category, item, message):
        self.results.append(Result(severity != "error", category, item, safe(message), severity))

    def ignored(self, path):
        rel = path.relative_to(self.root).as_posix()
        return any(fnmatch(rel, pattern) for pattern in self.ignores)

    def validate(self):
        current = ORDER[self.stage]
        for rel, stage in DIRS.items():
            exists, due = (self.root / rel).is_dir(), ORDER[stage] <= current
            self.add("info" if exists or not due else "error", "structure", rel + "/", "存在" if exists else ("后续阶段目录尚未创建" if not due else "当前阶段需要该目录"))
        for rel, (name, stage, required) in DOCS.items():
            exists, due = (self.root / rel).is_file(), ORDER[stage] <= current
            if exists: severity, message = "info", "存在"
            elif not due: severity, message = "info", "属于后续阶段，当前不要求"
            elif required: severity, message = "error", "当前阶段必需文档缺失"
            else: severity, message = "info", "按设计复杂度选用，不作为强制门禁"
            self.add(severity, "documents", f"{name} ({rel})", message)
        self.content()
        if self.trace: self.traceability()
        self.version_control(); self.formats()
        return not any(r.severity == "error" for r in self.results)

    def content(self):
        base = self.root / "docs"
        files = [] if not base.exists() else [p for p in base.rglob("*.md") if not self.ignored(p)]
        if not files: self.add("error", "content", "Markdown 文档", "未找到可检查文档"); return
        for path in files:
            text, rel = path.read_text("utf-8", errors="replace"), path.relative_to(self.root).as_posix()
            titled = text.lstrip().startswith("#")
            self.add("info" if titled else "error", "content", rel + " 标题", "存在" if titled else "缺少 Markdown 标题")
            if not ("版本历史" in text or re.search(r"version\s+history", text, re.I)):
                self.add("warning", "content", rel + " 版本历史", "建议增加版本历史")

    def traceability(self):
        reqdir, matrix = self.root / "docs/02_requirements", self.root / "docs/02_requirements/requirements_traceability.md"
        reqs, specs = set(), set()
        if reqdir.exists():
            for path in reqdir.rglob("*.md"):
                if path != matrix and not self.ignored(path):
                    text = path.read_text("utf-8", errors="replace"); reqs |= definitions(text, "REQ"); specs |= definitions(text, "SPEC")
        design = self.root / "docs/03_design"
        if design.exists():
            for path in design.rglob("*.md"):
                if not self.ignored(path): specs |= definitions(path.read_text("utf-8", errors="replace"), "SPEC")
        if not matrix.exists(): self.add("error", "traceability", "需求-规格追溯矩阵", "文件不存在"); return
        rel = matrix.relative_to(self.root).as_posix()
        selected = []
        for k, (heads, rows) in enumerate(tables(matrix.read_text("utf-8", errors="replace")), 1):
            norm = [re.sub(r"\s+", "", h).lower() for h in heads]
            rc = next((i for i, h in enumerate(norm) if h.startswith(("需求id", "关联需求id", "requirementid", "reqid"))), None)
            sc = next((i for i, h in enumerate(norm) if h.startswith(("规格id", "specificationid", "specid"))), None)
            if rc is not None and sc is not None: selected.append((k, heads, rows, rc, sc))
        if not selected: self.add("error", "traceability", "矩阵格式", "未找到同时包含“需求 ID”和“规格 ID”的表格"); return
        # mapped_*：ID -> [(表序号, 数据行)]，供缺失/未知诊断携带命中位置
        mapped_req, mapped_spec = {}, {}
        for k, heads, rows, rc, sc in selected:
            state_col = next((i for i, h in enumerate(heads) if re.sub(r"\s+", "", h).lower() in {"状态", "state", "status"}), None)
            for n, row in enumerate(rows, 1):
                for column, namespace, name, mapped in ((rc, "REQ", "需求", mapped_req), (sc, "SPEC", "规格", mapped_spec)):
                    cell = row[column]
                    recognized = ids(cell, namespace)
                    for found in recognized:
                        if (k, n) not in mapped.setdefault(found, []): mapped[found].append((k, n))
                    # 前缀错/无前缀的 ID 笔误与编号不存在一样显式报错，避免被静默丢弃（MG-DOC-001/002）
                    normalized = {value.upper() for value in recognized}
                    for token in sorted({t for t in COARSE_ID.findall(cell) if t.upper() not in normalized}):
                        self.add("error", "traceability", "矩阵 ID 格式",
                                 f"{rel} 表{k} 数据行{n} 列「{heads[column]}」：疑似 ID 格式错误：{token}（未识别为{name} ID）；请补全或修正命名空间前缀，如 {namespace}-{token}")
                if state_col is not None and row[state_col].strip().lower() not in STATES:
                    self.add("error", "traceability", f"矩阵状态（数据行 {n}）", "不受支持的状态：" + row[state_col])
        self.compare("需求", reqs, mapped_req); self.compare("规格", specs, mapped_spec)

    def compare(self, name, defined, mapped):
        if not defined:
            self.add("warning", "traceability", name + " ID 定义",
                     "未从标题或 ID 定义列识别到 ID；规范定义应写在 product_requirements.md / module_specification.md 的 ID 定义列或 ## <ID> 标题，仅写在追溯矩阵中的 ID 不被视为定义")
            return
        missing, unknown = sorted(defined - mapped.keys()), sorted(set(mapped) - defined)
        if missing:
            self.add("error", "traceability", name + "双向覆盖",
                     "缺少映射：" + ", ".join(missing) + "；以上 ID 在矩阵中未出现（若矩阵中已列，请检查命名空间前缀是否完整）")
        else:
            self.add("info", "traceability", name + "双向覆盖", f"{len(defined)} 个已定义 ID 均有映射")
        if unknown:
            locations = ", ".join(f"{u}（{'、'.join(f'表{k} 数据行{n}' for k, n in mapped[u])}）" for u in unknown)
            self.add("error", "traceability", "未知" + name + " ID", "矩阵引用了未定义 ID：" + locations)

    def version_control(self):
        git = (self.root / ".git").exists()
        self.add("info" if git else "warning", "version_control", ".git", "存在" if git else "未初始化 Git")
        attrs = (self.root / ".gitattributes").exists()
        self.add("info" if attrs else "warning", "version_control", ".gitattributes", "存在" if attrs else "建议固定文本文件 LF 策略")
        if git:
            for key in ("user.name", "user.email"):
                p = subprocess.run(["git", "-C", str(self.root), "config", "--local", "--get", key], capture_output=True, text=True, encoding="utf-8", errors="replace")
                self.add("info" if p.stdout.strip() else "warning", "version_control", key, p.stdout.strip() or "仓库本地配置缺失")

    def formats(self):
        base = self.root / "docs"
        if not base.exists(): return
        for path in base.rglob("*"):
            if not path.is_file() or self.ignored(path): continue
            rel = path.relative_to(self.root).as_posix()
            if path.suffix.lower() not in ALLOWED: self.add("warning", "format", rel, "非常用文档格式：" + (path.suffix or "无扩展名"))
            if path.suffix.lower() == ".md":
                try: path.read_text("utf-8")
                except UnicodeError as e: self.add("error", "format", rel + " 编码", "不是有效 UTF-8：" + str(e))

    def payload(self):
        errors = sum(r.severity == "error" for r in self.results)
        return safe({"passed": errors == 0, "project": self.root.name, "stage": self.stage, "check_time": datetime.now().isoformat(timespec="seconds"),
                     "summary": {"errors": errors, "warnings": sum(r.severity == "warning" for r in self.results), "checks": len(self.results)},
                     "results": [asdict(r) for r in self.results]})

    def report(self):
        data = self.payload(); lines = ["=" * 64, "MoonGlass 文档库与追溯关系检查报告", f"项目：{data['project']}", f"阶段：{data['stage']}", "=" * 64]
        labels = {"error": "错误", "warning": "警告", "info": "通过"}
        lines += [f"[{labels[r.severity]}] {r.category} / {r.item}：{r.message}" for r in self.results]
        lines += ["=" * 64, f"结果：{'通过' if data['passed'] else '未通过'}；{data['summary']['errors']} 错误，{data['summary']['warnings']} 警告"]
        return "\n".join(lines)

def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"): stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="MoonGlass ASIC 文档库与追溯关系校验器")
    parser.add_argument("--path", "-p", required=True); parser.add_argument("--stage", choices=STAGES + tuple(ALIASES), default="req_spec")
    parser.add_argument("--json", "-j", action="store_true"); parser.add_argument("--output", "-o"); parser.add_argument("--quiet", "-q", action="store_true")
    parser.add_argument("--no-traceability", action="store_true")
    args = parser.parse_args(); root = Path(args.path)
    if not root.exists(): parser.error(f"路径不存在：{root}")
    validator = Validator(root, args.stage, not args.no_traceability); passed = validator.validate()
    output = json.dumps(validator.payload(), ensure_ascii=False, indent=2) if args.json else validator.report()
    if args.output:
        target = Path(args.output); target.parent.mkdir(parents=True, exist_ok=True); target.write_text(output + "\n", "utf-8", errors="replace")
    if not args.quiet: print(output)
    return 0 if passed else 1

if __name__ == "__main__": raise SystemExit(main())
