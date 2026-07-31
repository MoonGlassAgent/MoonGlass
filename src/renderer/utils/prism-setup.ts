/**
 * Prism 语法高亮配置
 *
 * 显式加载所有需要的语言组件，确保 highlightAllUnder 能识别对应语言。
 * 不依赖动态 import（那个只加载核心），直接 import 副作用模块注册语言。
 */

import Prism from 'prismjs'

// 加载各语言组件（副作用：向 Prism.languages 注册）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import verilog from 'prismjs/components/prism-verilog'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import perl from 'prismjs/components/prism-perl'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import tcl from 'prismjs/components/prism-tcl'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import python from 'prismjs/components/prism-python'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import log from 'prismjs/components/prism-log'

// 额外语言
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import bash from 'prismjs/components/prism-bash'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import json from 'prismjs/components/prism-json'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import yaml from 'prismjs/components/prism-yaml'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import markup from 'prismjs/components/prism-markup'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import cpp from 'prismjs/components/prism-cpp'

const fallbackVerilog: Prism.Grammar = {
  comment: [
    { pattern: /\/\*[\s\S]*?\*\//, greedy: true },
    { pattern: /\/\/.*/, greedy: true }
  ],
  string: { pattern: /"(?:\\.|[^"\\])*"/, greedy: true },
  keyword:
    /\b(?:always|always_comb|always_ff|always_latch|assign|begin|case|casex|casez|default|else|end|endcase|endfunction|endmodule|endtask|for|function|generate|if|inout|input|integer|localparam|logic|module|output|parameter|reg|signed|task|wire)\b/,
  number: /\b(?:\d+'[sS]?[bBoOdDhH][\da-fA-F_xXzZ?]+|\d+(?:\.\d+)?)\b/,
  operator: /(?:===?|!==?|&&|\|\||<<<?|>>>?|[-+*/%&|^~!]=?|[<>]=?)/,
  punctuation: /[{}[\];(),.:#@]/
}

const fallbackPython: Prism.Grammar = {
  comment: /#.*/,
  string: { pattern: /(?:'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/, greedy: true },
  keyword: /\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|not|or|pass|raise|return|True|try|while|with|yield)\b/,
  number: /\b(?:0[xob][\da-f]+|\d+(?:\.\d+)?)\b/i,
  operator: /(?:\*\*|\/\/|:=|[-+*/%@&|^~<>]=?|==|!=)/,
  punctuation: /[{}[\];(),.:]/
}

const fallbackJson: Prism.Grammar = {
  property: { pattern: /(^|[{,]\s*)"(?:\\.|[^"\\])*"(?=\s*:)/, lookbehind: true, greedy: true },
  string: { pattern: /"(?:\\.|[^"\\])*"/, greedy: true },
  comment: /\/\/.*|\/\*[\s\S]*?\*\//,
  number: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/i,
  boolean: /\b(?:false|true)\b/,
  null: { pattern: /\bnull\b/, alias: 'keyword' },
  punctuation: /[{}[\],]/,
  operator: /:/
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function highlightCode(code: string, language: string): string {
  const fallback = language === 'verilog'
    ? fallbackVerilog
    : language === 'python'
      ? fallbackPython
      : language === 'json'
        ? fallbackJson
        : undefined
  const grammar = Prism.languages[language] ?? fallback
  return grammar ? Prism.highlight(code, grammar, language) : escapeHtml(code)
}

export default Prism
