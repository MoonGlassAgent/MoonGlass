#!/usr/bin/env python3
"""
Verification Environment Validator
验证环境完整性与编码规范检查器

合并了 qa-verification 和 cocotb-verification 的检查能力。
检查项涵盖：目录结构、必需文件、Golden Model、测试用例、
Scoreboard、Makefile、编码规范（日志、cocotb.start_soon 等）。

Usage:
    python validate_env.py --path ./verification_env
    python validate_env.py --path ./verification_env --json
    python validate_env.py --path ./verification_env --quiet
"""

import argparse
import re
import json
from pathlib import Path
from dataclasses import dataclass
from typing import List
from datetime import datetime


@dataclass
class ValidationResult:
    """验证结果"""
    passed: bool
    category: str
    item: str
    message: str
    severity: str  # error, warning, info


class VerificationValidator:
    """验证环境完整性与编码规范检查器"""

    def __init__(self, base_path: str):
        self.base_path = Path(base_path)
        self.results: List[ValidationResult] = []

    def validate(self) -> bool:
        """执行所有验证"""
        self.results.clear()

        # 1. 检查目录结构
        self._check_directory_structure()

        # 2. 检查必需文件
        self._check_required_files()

        # 3. 检查 Golden Model
        self._check_golden_model()

        # 4. 检查测试用例
        self._check_test_cases()

        # 5. 检查 Scoreboard
        self._check_scoreboard()

        # 6. 检查 Makefile
        self._check_makefile()

        # 7. 检查编码规范
        self._check_coding_standard()

        # 返回是否全部通过（ERROR 级别必须全部通过）
        return all(r.passed for r in self.results if r.severity == 'error')

    # ================================================================
    # 目录结构检查
    # ================================================================
    def _check_directory_structure(self):
        """检查目录结构"""
        required_dirs = ['tests', 'sim']
        optional_dirs = ['agents', 'env', 'coverage', 'rtl']

        for dir_name in required_dirs:
            dir_path = self.base_path / dir_name
            if dir_path.exists():
                self._pass('structure', f'目录 {dir_name}/', '存在')
            else:
                self._error('structure', f'目录 {dir_name}/', '不存在')

        for dir_name in optional_dirs:
            dir_path = self.base_path / dir_name
            if dir_path.exists():
                self._pass('structure', f'目录 {dir_name}/', '存在（可选）')

    # ================================================================
    # 必需文件检查
    # ================================================================
    def _check_required_files(self):
        """检查必需文件"""
        # 检查测试文件
        tests_dir = self.base_path / 'tests'
        if tests_dir.exists():
            test_files = list(tests_dir.glob('test_*.py'))
            if test_files:
                self._pass('files', '测试文件', f'找到 {len(test_files)} 个')
            else:
                self._error('files', '测试文件', '未找到 test_*.py 文件')
        else:
            self._error('files', '测试目录', 'tests/ 目录不存在')

        # 检查 Makefile（sim/ 或根目录）
        makefile = self.base_path / 'sim' / 'Makefile'
        if not makefile.exists():
            makefile = self.base_path / 'Makefile'
        if makefile.exists():
            self._pass('files', 'Makefile', f'{makefile.relative_to(self.base_path)} 存在')
        else:
            self._error('files', 'Makefile', '未找到 Makefile')

        # 检查 Golden Model 文件
        gm_files = list(self.base_path.rglob('*golden*model*.py'))
        if gm_files:
            self._pass('files', 'Golden Model', f'找到 {len(gm_files)} 个')
        else:
            self._error('files', 'Golden Model', '未找到 golden_model 相关文件')

    # ================================================================
    # Golden Model 检查
    # ================================================================
    def _check_golden_model(self):
        """检查 Golden Model 实现"""
        golden_model_files = list(self.base_path.rglob('*golden*model*.py'))
        if not golden_model_files:
            return

        for gm_file in golden_model_files:
            content = gm_file.read_text(encoding='utf-8', errors='ignore')
            rel = gm_file.relative_to(self.base_path)

            # 检查是否继承 GoldenModelBase
            if 'GoldenModelBase' in content:
                self._pass('golden_model', f'{rel} 继承', '继承 GoldenModelBase')
            else:
                self._warning('golden_model', f'{rel} 继承',
                              '未找到 GoldenModelBase 继承')

            # 检查 process() 方法
            if 'def process(' in content:
                self._pass('golden_model', f'{rel} process()', '已实现')
            else:
                self._error('golden_model', f'{rel} process()', '未实现 process() 方法')

            # 检查 reset() 方法
            if 'def reset(' in content:
                self._pass('golden_model', f'{rel} reset()', '已实现')
            else:
                self._warning('golden_model', f'{rel} reset()', '未实现 reset() 方法')

    # ================================================================
    # 测试用例检查
    # ================================================================
    def _check_test_cases(self):
        """检查测试用例"""
        tests_dir = self.base_path / 'tests'
        if not tests_dir.exists():
            return

        test_files = list(tests_dir.glob('test_*.py'))
        if not test_files:
            return

        for test_file in test_files:
            content = test_file.read_text(encoding='utf-8', errors='ignore')
            rel = test_file.relative_to(self.base_path)

            # 检查 @cocotb.test 装饰器
            test_count = len(re.findall(r'@cocotb\.test', content))
            if test_count > 0:
                self._pass('tests', f'{rel}', f'包含 {test_count} 个测试')
            else:
                self._warning('tests', f'{rel}', '未找到 @cocotb.test 装饰器')

            # 检查时钟初始化
            if 'Clock(' in content:
                self._pass('tests', f'{rel} 时钟', '包含时钟初始化')
            else:
                self._warning('tests', f'{rel} 时钟', '可能缺少时钟初始化')

            # 检查断言
            assert_count = len(re.findall(r'\bassert\b', content))
            if assert_count > 0:
                self._pass('tests', f'{rel} 断言', f'包含 {assert_count} 个断言')
            else:
                self._error('tests', f'{rel} 断言', '未找到断言，缺少验证逻辑')

            # 检查 Pass/Fail 输出
            has_result = ('PASSED' in content or 'FAILED' in content or
                          'TestSuccess' in content or 'TestFailure' in content or
                          'log_test_end' in content)
            if has_result:
                self._pass('tests', f'{rel} 结果', '包含 Pass/Fail 输出')
            else:
                self._warning('tests', f'{rel} 结果', '建议添加 log_test_start/end')

    # ================================================================
    # Scoreboard 检查
    # ================================================================
    def _check_scoreboard(self):
        """检查 Scoreboard"""
        scoreboard_files = list(self.base_path.rglob('*scoreboard*.py'))
        if not scoreboard_files:
            self._info('scoreboard', 'Scoreboard', '未找到（简单设计可能不需要）')
            return

        for sb_file in scoreboard_files:
            content = sb_file.read_text(encoding='utf-8', errors='ignore')
            rel = sb_file.relative_to(self.base_path)

            # 检查 check/compare 方法
            if 'def check(' in content or 'def compare(' in content:
                self._pass('scoreboard', f'{rel}', '包含 check/compare 方法')
            else:
                self._error('scoreboard', f'{rel}', '缺少 check/compare 方法')

            # 检查是否集成 Golden Model
            if 'golden_model' in content.lower() or 'predict' in content:
                self._pass('scoreboard', f'{rel} GM 集成', '集成了参考模型')
            else:
                self._warning('scoreboard', f'{rel} GM 集成',
                              '建议通过 golden_model.predict() 自动比对')

    # ================================================================
    # Makefile 检查
    # ================================================================
    def _check_makefile(self):
        """检查 Makefile"""
        makefile = self.base_path / 'sim' / 'Makefile'
        if not makefile.exists():
            makefile = self.base_path / 'Makefile'
        if not makefile.exists():
            return

        content = makefile.read_text(encoding='utf-8', errors='ignore')

        # cocotb 配置
        if 'cocotb-config' in content or 'cocotb' in content.lower():
            self._pass('makefile', 'Cocotb 集成', '正确配置')
        else:
            self._error('makefile', 'Cocotb 集成', '未配置 Cocotb')

        # TOPLEVEL
        if 'TOPLEVEL' in content:
            self._pass('makefile', 'TOPLEVEL', '已设置')
        else:
            self._error('makefile', 'TOPLEVEL', '未设置顶层模块')

        # SIM
        if 'SIM' in content:
            self._pass('makefile', 'SIM', '支持仿真器选择')
        else:
            self._warning('makefile', 'SIM', '未配置仿真器选择')

        # MODULE
        if 'MODULE' in content:
            self._pass('makefile', 'MODULE', '已设置测试模块')
        else:
            self._warning('makefile', 'MODULE', '未设置测试模块')

    # ================================================================
    # 编码规范检查
    # ================================================================
    def _check_coding_standard(self):
        """检查编码规范（基于 coding_standard.md）"""
        py_files = list(self.base_path.rglob('*.py'))
        if not py_files:
            return

        has_deprecated_fork = False
        has_missing_repr = False

        for py_file in py_files:
            content = py_file.read_text(encoding='utf-8', errors='ignore')
            rel = py_file.relative_to(self.base_path)

            # 检查 cocotb.fork 使用（应改为 cocotb.start_soon）
            fork_count = len(re.findall(r'cocotb\.fork\(', content))
            if fork_count > 0:
                has_deprecated_fork = True
                self._warning('coding', f'{rel}',
                              f'使用了已弃用的 cocotb.fork() ({fork_count} 处)，'
                              f'应改为 cocotb.start_soon()')

            # 检查 Transaction 类是否有 __repr__
            if 'Transaction' in py_file.name or 'transaction' in py_file.name:
                has_class = 'class ' in content and 'dataclass' in content
                if has_class:
                    if '__repr__' in content or '__str__' in content:
                        self._pass('coding', f'{rel} __repr__', '事务类包含字符串表示')
                    else:
                        has_missing_repr = True
                        self._warning('coding', f'{rel} __repr__',
                                      '事务类建议实现 __repr__ 便于日志输出')

        # 总结
        if not has_deprecated_fork:
            self._pass('coding', 'cocotb.start_soon', '未使用已弃用的 cocotb.fork()')

    # ================================================================
    # 结果记录
    # ================================================================
    def _pass(self, category: str, item: str, message: str):
        self.results.append(ValidationResult(True, category, item, message, 'info'))

    def _error(self, category: str, item: str, message: str):
        self.results.append(ValidationResult(False, category, item, message, 'error'))

    def _warning(self, category: str, item: str, message: str):
        self.results.append(ValidationResult(True, category, item, message, 'warning'))

    def _info(self, category: str, item: str, message: str):
        self.results.append(ValidationResult(True, category, item, message, 'info'))

    # ================================================================
    # 报告输出
    # ================================================================
    def report(self) -> str:
        """生成文本报告"""
        lines = []
        lines.append("=" * 60)
        lines.append("        验证环境完整性检查报告")
        lines.append("=" * 60)
        lines.append(f"路径: {self.base_path}")
        lines.append(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append("=" * 60)

        # 按类别分组
        categories = {}
        for r in self.results:
            if r.category not in categories:
                categories[r.category] = []
            categories[r.category].append(r)

        # 类别顺序
        cat_order = ['structure', 'files', 'golden_model', 'tests',
                      'scoreboard', 'makefile', 'coding']
        for cat in cat_order:
            if cat not in categories:
                continue
            results = categories[cat]
            lines.append(f"\n[{cat.upper()}]")
            for r in results:
                if r.severity == 'error' and not r.passed:
                    status = "[ERROR]"
                elif r.severity == 'warning':
                    status = "[WARN] "
                else:
                    status = "[OK]   "
                lines.append(f"  {status} {r.item}: {r.message}")

        # 统计
        errors = sum(1 for r in self.results if r.severity == 'error' and not r.passed)
        warnings = sum(1 for r in self.results if r.severity == 'warning')
        passed = sum(1 for r in self.results if r.passed)

        lines.append("\n" + "=" * 60)
        lines.append(f"总计: {passed} 通过, {warnings} 警告, {errors} 错误")
        if errors == 0:
            lines.append("结果: PASS")
        else:
            lines.append("结果: FAIL")
            lines.append("\n需要修复:")
            for r in self.results:
                if r.severity == 'error' and not r.passed:
                    lines.append(f"  - [{r.category}] {r.item}: {r.message}")
        lines.append("=" * 60)

        return "\n".join(lines)

    def to_json(self) -> str:
        """输出 JSON 格式"""
        errors = sum(1 for r in self.results if r.severity == 'error' and not r.passed)

        return json.dumps({
            'passed': errors == 0,
            'path': str(self.base_path),
            'check_time': datetime.now().isoformat(),
            'summary': {
                'passed': sum(1 for r in self.results if r.passed),
                'warnings': sum(1 for r in self.results if r.severity == 'warning'),
                'errors': errors
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
        description='验证环境完整性与编码规范检查器',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
    python validate_env.py --path ./verification_env
    python validate_env.py --path ./verification_env --json
    python validate_env.py --path ./verification_env --quiet
        """
    )
    parser.add_argument('--path', '-p', required=True,
                        help='验证环境路径')
    parser.add_argument('--json', '-j', action='store_true',
                        help='输出 JSON 格式')
    parser.add_argument('--quiet', '-q', action='store_true',
                        help='静默模式，仅返回退出码')

    args = parser.parse_args()

    if not Path(args.path).exists():
        print(f"错误: 路径不存在: {args.path}")
        exit(1)

    validator = VerificationValidator(args.path)
    passed = validator.validate()

    if args.quiet:
        exit(0 if passed else 1)

    if args.json:
        print(validator.to_json())
    else:
        print(validator.report())

    exit(0 if passed else 1)


if __name__ == '__main__':
    main()
