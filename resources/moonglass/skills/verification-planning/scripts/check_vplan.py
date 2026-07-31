#!/usr/bin/env python3
"""
Verification Plan Checker
验证计划完整性检查器

检查验证计划文档是否包含所有必需部分，
以及需求追溯是否完整（无遗漏特性）。

Usage:
    python check_vplan.py --path /path/to/vplan.md
    python check_vplan.py --path /path/to/vplan.md --json
"""

import argparse
import re
import json
from pathlib import Path
from dataclasses import dataclass
from typing import List, Set, Tuple
from datetime import datetime


@dataclass
class CheckResult:
    passed: bool
    category: str
    item: str
    message: str
    severity: str  # error, warning, info


class VPlanChecker:
    """验证计划完整性检查器"""

    def __init__(self, file_path: str):
        self.file_path = Path(file_path)
        self.content = ""
        self.results: List[CheckResult] = []
        self.features: Set[str] = set()
        self.testcases: Set[str] = set()
        self.covergroups: Set[str] = set()
        self.traced_features: Set[str] = set()

    def check(self) -> bool:
        """执行所有检查"""
        self.results.clear()

        if not self.file_path.exists():
            self._error('file', '文件', f'{self.file_path} 不存在')
            return False

        self.content = self.file_path.read_text(encoding='utf-8', errors='ignore')

        self._check_sections()
        self._extract_features()
        self._extract_testcases()
        self._extract_covergroups()
        self._check_traceability()
        self._check_priorities()

        return all(r.passed for r in self.results if r.severity == 'error')

    def _check_sections(self):
        """检查必需章节"""
        required_sections = {
            '设计规格': ['设计规格', '模块', '接口', '功能'],
            '特性列表': ['特性', 'Feature', 'F0'],
            '测试用例': ['测试用例', 'Test', 'TC0'],
            '覆盖率': ['覆盖率', 'Coverage', 'CG_'],
            '追溯矩阵': ['追溯', 'Trace', 'Feature.*TC'],
        }

        for section, keywords in required_sections.items():
            found = any(kw in self.content for kw in keywords)
            if found:
                self._pass('sections', section, '存在')
            else:
                self._error('sections', section, f'未找到（关键词: {keywords[0]}...）')

    def _extract_features(self):
        """提取特性编号"""
        # 匹配 F001, F010 等
        self.features = set(re.findall(r'\bF\d{3}\b', self.content))
        count = len(self.features)
        if count > 0:
            self._pass('features', '特性数量', f'找到 {count} 个特性')
        else:
            self._error('features', '特性数量', '未找到 Fxxx 格式的特性编号')

    def _extract_testcases(self):
        """提取测试用例编号"""
        # 匹配 TC001, TC010 等
        self.testcases = set(re.findall(r'\bTC\d{3}\b', self.content))
        count = len(self.testcases)
        if count > 0:
            self._pass('testcases', '用例数量', f'找到 {count} 个测试用例')
        else:
            self._error('testcases', '用例数量', '未找到 TCxxx 格式的用例编号')

    def _extract_covergroups(self):
        """提取覆盖率组"""
        # 匹配 CG_xxx 或 CROSS_xxx
        cg = set(re.findall(r'\b(?:CG|CROSS)_[A-Z_]+\b', self.content))
        self.covergroups = cg
        count = len(cg)
        if count > 0:
            self._pass('coverage', '覆盖率组数量', f'找到 {count} 个覆盖率组')
        else:
            self._warning('coverage', '覆盖率组数量', '未找到 CG_xxx 格式的覆盖率组')

    def _check_traceability(self):
        """检查需求追溯完整性"""
        if not self.features:
            return

        # 在追溯矩阵或测试用例列表中查找每个特性是否被引用
        # 查找 [Fxxx] 或 Fxxx 出现在 TC 行中的模式
        traced = set()
        for f in self.features:
            # 检查是否在测试用例描述行中被引用
            pattern = rf'TC\d{{3}}.*{f}|{f}.*TC\d{{3}}'
            if re.search(pattern, self.content):
                traced.add(f)

        self.traced_features = traced
        untraced = self.features - traced

        if not untraced:
            self._pass('traceability', '需求追溯', f'所有 {len(self.features)} 个特性均已追溯')
        else:
            sorted_untraced = sorted(untraced)
            self._error('traceability', '未追溯特性',
                        f'{len(untraced)} 个特性未关联测试用例: {", ".join(sorted_untraced)}')

    def _check_priorities(self):
        """检查测试优先级分布"""
        p0_count = len(re.findall(r'\bP0\b', self.content))
        p1_count = len(re.findall(r'\bP1\b', self.content))
        p2_count = len(re.findall(r'\bP2\b', self.content))
        total = p0_count + p1_count + p2_count

        if total > 0:
            self._pass('priority', '优先级分布',
                        f'P0={p0_count}, P1={p1_count}, P2={p2_count}')
            if p0_count == 0:
                self._warning('priority', 'P0 冒烟测试', '未找到 P0 级别用例')
        else:
            self._info('priority', '优先级', '未找到 P0/P1/P2 优先级标记')

    def _pass(self, cat: str, item: str, msg: str):
        self.results.append(CheckResult(True, cat, item, msg, 'info'))

    def _error(self, cat: str, item: str, msg: str):
        self.results.append(CheckResult(False, cat, item, msg, 'error'))

    def _warning(self, cat: str, item: str, msg: str):
        self.results.append(CheckResult(True, cat, item, msg, 'warning'))

    def _info(self, cat: str, item: str, msg: str):
        self.results.append(CheckResult(True, cat, item, msg, 'info'))

    def report(self) -> str:
        lines = []
        lines.append("=" * 60)
        lines.append("        验证计划完整性检查报告")
        lines.append("=" * 60)
        lines.append(f"文件: {self.file_path}")
        lines.append(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append("=" * 60)

        categories = {}
        for r in self.results:
            categories.setdefault(r.category, []).append(r)

        for cat in ['sections', 'features', 'testcases', 'coverage',
                     'traceability', 'priority']:
            if cat not in categories:
                continue
            lines.append(f"\n[{cat.upper()}]")
            for r in categories[cat]:
                if r.severity == 'error' and not r.passed:
                    tag = "[ERROR]"
                elif r.severity == 'warning':
                    tag = "[WARN] "
                else:
                    tag = "[OK]   "
                lines.append(f"  {tag} {r.item}: {r.message}")

        errors = sum(1 for r in self.results if r.severity == 'error' and not r.passed)
        warnings = sum(1 for r in self.results if r.severity == 'warning')

        lines.append("\n" + "=" * 60)
        lines.append(f"统计: 特性 {len(self.features)} 个, "
                     f"用例 {len(self.testcases)} 个, "
                     f"覆盖率组 {len(self.covergroups)} 个")
        lines.append(f"结果: {'PASS' if errors == 0 else 'FAIL'} "
                     f"({errors} 错误, {warnings} 警告)")
        lines.append("=" * 60)
        return "\n".join(lines)

    def to_json(self) -> str:
        errors = sum(1 for r in self.results if r.severity == 'error' and not r.passed)
        return json.dumps({
            'passed': errors == 0,
            'file': str(self.file_path),
            'check_time': datetime.now().isoformat(),
            'stats': {
                'features': len(self.features),
                'testcases': len(self.testcases),
                'covergroups': len(self.covergroups),
                'traced': len(self.traced_features),
                'untraced': len(self.features - self.traced_features),
            },
            'results': [
                {
                    'passed': r.passed,
                    'category': r.category,
                    'item': r.item,
                    'message': r.message,
                    'severity': r.severity
                }
                for r in self.results
            ]
        }, indent=2, ensure_ascii=False)


def main():
    parser = argparse.ArgumentParser(
        description='验证计划完整性检查器',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
    python check_vplan.py --path ./verification_plan.md
    python check_vplan.py --path ./verification_plan.md --json
        """
    )
    parser.add_argument('--path', '-p', required=True, help='验证计划文件路径')
    parser.add_argument('--json', '-j', action='store_true', help='JSON 输出')
    parser.add_argument('--quiet', '-q', action='store_true', help='静默模式')

    args = parser.parse_args()

    checker = VPlanChecker(args.path)
    passed = checker.check()

    if args.quiet:
        exit(0 if passed else 1)
    if args.json:
        print(checker.to_json())
    else:
        print(checker.report())

    exit(0 if passed else 1)


if __name__ == '__main__':
    main()
