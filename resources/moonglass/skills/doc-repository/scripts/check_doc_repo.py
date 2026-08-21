#!/usr/bin/env python3
"""
Document Repository Validator
文档库完整性检查器

用于检查芯片项目文档库是否符合规范。
可作为项目启动时的检查工具，或 CI/CD 的一部分。

Usage:
    python check_doc_repo.py --path /path/to/project
    python check_doc_repo.py --path /path/to/project --json
"""

import argparse
import os
import re
import json
from pathlib import Path
from dataclasses import dataclass
from typing import List, Dict, Optional
from datetime import datetime


@dataclass
class ValidationResult:
    """验证结果"""
    passed: bool
    category: str
    item: str
    message: str
    severity: str  # error, warning, info


class DocumentRepositoryValidator:
    """文档库检查器"""

    def __init__(self, base_path: str):
        self.base_path = Path(base_path)
        self.results: List[ValidationResult] = []
        self.project_name = self.base_path.name

    def validate(self) -> bool:
        """执行所有验证"""
        self.results.clear()

        # 1. 检查目录结构
        self._check_directory_structure()

        # 2. 检查必需文档
        self._check_required_documents()

        # 3. 检查文档内容
        self._check_document_content()

        # 4. 检查版本控制
        self._check_version_control()

        # 5. 检查文档格式
        self._check_document_format()

        # 返回是否全部通过（忽略 warning）
        return all(r.passed for r in self.results if r.severity == 'error')

    def _check_directory_structure(self):
        """检查目录结构"""
        # 必需目录
        required_dirs = [
            'docs',
            'docs/01_project',
            'docs/02_requirements',
            'docs/03_design',
            'docs/04_verification',
            'scripts'
        ]

        # 可选目录
        optional_dirs = [
            'docs/05_implementation',
            'docs/06_validation',
            'docs/07_release',
            'templates'
        ]

        for dir_name in required_dirs:
            dir_path = self.base_path / dir_name
            if dir_path.exists() and dir_path.is_dir():
                self._pass('structure', f'目录 {dir_name}/', '存在')
            else:
                self._error('structure', f'目录 {dir_name}/', '不存在')

        for dir_name in optional_dirs:
            dir_path = self.base_path / dir_name
            if dir_path.exists() and dir_path.is_dir():
                self._pass('structure', f'目录 {dir_name}/', '存在（可选）')
            else:
                self._warning('structure', f'目录 {dir_name}/', '不存在（建议创建）')

    def _check_required_documents(self):
        """检查必需文档"""
        # 必需文档
        required_docs = {
            'docs/01_project/project_charter.md': '项目章程',
            'docs/02_requirements/product_requirements.md': '产品需求',
            'docs/03_design/architecture.md': '架构设计',
            'docs/04_verification/verification_plan.md': '验证计划'
        }

        # 可选文档
        optional_docs = {
            'docs/02_requirements/module_specification.md': '模块规格说明书',
            'docs/02_requirements/requirements_traceability.md': '需求-规格追溯矩阵',
            'docs/03_design/register_map.md': '寄存器映射表',
            'docs/03_design/microarchitecture.md': '微架构设计',
            'docs/03_design/clock_reset.md': '时钟复位设计',
            'docs/04_verification/test_plan.md': '测试计划'
        }

        for doc_path, doc_name in required_docs.items():
            full_path = self.base_path / doc_path
            if full_path.exists():
                self._pass('documents', f'{doc_name} ({doc_path})', '存在')
            else:
                self._error('documents', f'{doc_name} ({doc_path})', '不存在')

        for doc_path, doc_name in optional_docs.items():
            full_path = self.base_path / doc_path
            if full_path.exists():
                self._pass('documents', f'{doc_name} ({doc_path})', '存在（可选）')
            else:
                self._info('documents', f'{doc_name} ({doc_path})', '不存在（建议创建）')

    def _check_document_content(self):
        """检查文档内容"""
        docs_dir = self.base_path / 'docs'
        if not docs_dir.exists():
            self._error('content', '文档目录', 'docs/ 目录不存在，无法检查内容')
            return

        # 查找所有 Markdown 文件
        md_files = list(docs_dir.rglob('*.md'))

        if not md_files:
            self._error('content', 'Markdown 文档', '未找到任何.md 文档')
            return

        missing_version_history = []
        missing_revision_history = []
        missing_approval = []

        for md_file in md_files:
            content = md_file.read_text(encoding='utf-8', errors='ignore')
            rel_path = md_file.relative_to(self.base_path)

            # 检查文档标题
            has_title = content.strip().startswith('#')
            if has_title:
                self._pass('content', f'{rel_path} 标题', '有文档标题')
            else:
                self._error('content', f'{rel_path} 标题', '缺少文档标题')

            # 检查版本历史
            has_version = ('版本历史' in content or 
                          'Version History' in content.lower() or
                          re.search(r'\|\s*版本\s*\|', content))
            if has_version:
                self._pass('content', f'{rel_path} 版本历史', '包含版本历史')
            else:
                missing_version_history.append(rel_path)

            # 检查修订记录
            has_revision = ('修订' in content or 
                           'Revision' in content or
                           '变更' in content or
                           re.search(r'\|\s*变更\s*\|', content))
            if has_revision:
                self._pass('content', f'{rel_path} 修订记录', '包含修订记录')
            else:
                missing_revision_history.append(rel_path)

            # 检查审批签名（关键文档）
            critical_docs = ['project_charter.md', 'product_requirements.md', 'module_specification.md',
                           'architecture.md', 'verification_plan.md']
            if md_file.name in critical_docs:
                has_approval = ('审批' in content or 
                               'Approval' in content.lower() or
                               '签名' in content or
                               re.search(r'\|\s*签名\s*\|', content))
                if has_approval:
                    self._pass('content', f'{rel_path} 审批签名', '包含审批栏')
                else:
                    missing_approval.append(rel_path)

        # 汇总报告
        if missing_version_history:
            for f in missing_version_history:
                self._warning('content', f'{f} 版本历史', '缺少版本历史表')
        
        if missing_revision_history:
            for f in missing_revision_history:
                self._info('content', f'{f} 修订记录', '建议添加修订记录')
        
        if missing_approval:
            for f in missing_approval:
                self._error('content', f'{f} 审批签名', '缺少审批签名栏')

    def _check_version_control(self):
        """检查版本控制"""
        # 检查 Git 目录
        git_dir = self.base_path / '.git'
        if git_dir.exists() and git_dir.is_dir():
            self._pass('version_control', '.git 目录', '存在')
        else:
            self._error('version_control', '.git 目录', '不存在，未使用 Git 版本控制')

        # 检查 .gitignore
        gitignore = self.base_path / '.gitignore'
        if gitignore.exists():
            content = gitignore.read_text(encoding='utf-8', errors='ignore')
            
            # 检查是否忽略常见临时文件
            has_doc_ignore = 'docs/' in content or '!docs/' in content
            if has_doc_ignore:
                self._pass('version_control', '.gitignore', '配置正确')
            else:
                self._warning('version_control', '.gitignore', '建议明确文档目录策略')
        else:
            self._error('version_control', '.gitignore', '不存在')

    def _check_document_format(self):
        """检查文档格式"""
        docs_dir = self.base_path / 'docs'
        if not docs_dir.exists():
            return

        # 查找所有文件
        all_files = list(docs_dir.rglob('*'))
        
        # 检查非 Markdown 文件
        non_md_docs = [f for f in all_files 
                       if f.is_file() and 
                       f.suffix.lower() not in ['.md', '.gitkeep', '.png', '.jpg', '.svg']]
        
        if non_md_docs:
            for f in non_md_docs:
                rel_path = f.relative_to(self.base_path)
                self._warning('format', f'{rel_path}', 
                             f'非标准格式 ({f.suffix})，建议使用 Markdown')
        else:
            self._pass('format', '文档格式', '所有文档都是 Markdown 格式')

        # 检查 Markdown 文件编码 - 使用更宽松的检查
        md_files = list(docs_dir.rglob('*.md'))
        encoding_issues = []

        for md_file in md_files:
            try:
                # 尝试多种编码读取
                content = None
                for encoding in ['utf-8', 'gbk', 'gb2312', 'utf-8-sig']:
                    try:
                        content = md_file.read_text(encoding=encoding)
                        break
                    except UnicodeDecodeError:
                        continue
                
                if content is None:
                    encoding_issues.append(md_file)
                    continue
                    
                # 检查是否有常见乱码特征（空字符）
                if '\x00' in content:
                    encoding_issues.append(md_file)
            except Exception:
                encoding_issues.append(md_file)

        if encoding_issues:
            for f in encoding_issues:
                rel_path = f.relative_to(self.base_path)
                self._error('format', f'{rel_path} 编码', '非 UTF-8 编码或包含乱码')
        else:
            self._pass('format', 'UTF-8 编码', '所有文档编码正确')

    def _pass(self, category: str, item: str, message: str):
        self.results.append(ValidationResult(True, category, item, message, 'info'))

    def _error(self, category: str, item: str, message: str):
        self.results.append(ValidationResult(False, category, item, message, 'error'))

    def _warning(self, category: str, item: str, message: str):
        self.results.append(ValidationResult(True, category, item, message, 'warning'))

    def _info(self, category: str, item: str, message: str):
        self.results.append(ValidationResult(True, category, item, message, 'info'))

    def report(self) -> str:
        """生成报告"""
        lines = []
        lines.append("=" * 60)
        lines.append("        文档库完整性检查报告")
        lines.append("=" * 60)
        lines.append(f"项目：{self.project_name}")
        lines.append(f"检查时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append("=" * 60)

        # 按类别分组
        categories = {}
        for r in self.results:
            if r.category not in categories:
                categories[r.category] = []
            categories[r.category].append(r)

        # 输出各类别
        category_order = ['structure', 'documents', 'content', 'version_control', 'format']
        for cat in category_order:
            if cat not in categories:
                continue
            results = categories[cat]
            lines.append(f"\n[{cat.upper()}]")
            for r in results:
                if r.severity == 'error':
                    status = "[ERROR]"
                elif r.severity == 'warning':
                    status = "[WARN]"
                else:
                    status = "[OK]"
                lines.append(f"  {status} {r.item}: {r.message}")

        # 统计
        errors = sum(1 for r in self.results if r.severity == 'error')
        warnings = sum(1 for r in self.results if r.severity == 'warning')
        passed = sum(1 for r in self.results if r.passed)

        lines.append("\n" + "=" * 60)
        lines.append(f"总计：{passed} 通过，{warnings} 警告，{errors} 错误")
        
        if errors == 0:
            lines.append("结果：[PASS] 通过")
        else:
            lines.append("结果：[FAIL] 未通过（有 ERROR 级别问题）")
            lines.append("\n需要修复的问题:")
            for r in self.results:
                if r.severity == 'error':
                    lines.append(f"  {r.category}: {r.item} - {r.message}")
        
        lines.append("=" * 60)

        return "\n".join(lines)

    def to_json(self) -> str:
        """输出 JSON 格式结果"""
        errors = sum(1 for r in self.results if r.severity == 'error')

        return json.dumps({
            'passed': errors == 0,
            'project': self.project_name,
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
        description='文档库完整性检查器',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
    python check_doc_repo.py --path ./my_chip_project
    python check_doc_repo.py --path ./my_chip_project --json
    python check_doc_repo.py --path ./my_chip_project --verbose
        """
    )
    parser.add_argument('--path', '-p', required=True,
                        help='项目根路径')
    parser.add_argument('--json', '-j', action='store_true',
                        help='输出 JSON 格式')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='输出详细报告')
    parser.add_argument('--quiet', '-q', action='store_true',
                        help='静默模式，仅返回退出码')

    args = parser.parse_args()

    if not Path(args.path).exists():
        print(f"错误：路径不存在：{args.path}")
        exit(1)

    validator = DocumentRepositoryValidator(args.path)
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
