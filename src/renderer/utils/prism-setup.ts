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

export default Prism
