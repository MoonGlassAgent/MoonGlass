// moonglass-no-clk-rst-in-comb 规则冒烟：合成 RTL 样例验证违规检出与误报豁免
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { clkRstInCombIssues, runDesignLint } = await import('../packages/eda-bridge/src/lint.ts')
const root = mkdtempSync(join(tmpdir(), 'moonglass-clk-rst-comb-'))

const badAssign = join(root, 'bad_assign.v')
writeFileSync(badAssign, `module bad_assign(input wire i_clk, input wire i_rst_n, input wire en, output wire busy);
wire clk;
assign clk = i_clk;
// 时钟与门控进组合逻辑：违规
assign busy = clk & en;
assign rst_busy = i_rst_n & busy;
endmodule
`)

const badCombAlways = join(root, 'bad_comb_always.v')
writeFileSync(badCombAlways, `module bad_comb_always(input wire clk, input wire rst_n, input wire en, output reg gate);
always @(*) begin
  // 复位信号出现在组合块条件：违规
  if (rst_n) gate = en;
  else gate = 1'b0;
end
always @(posedge clk or negedge rst_n) begin
  if (!rst_n) gate <= 1'b0;
end
endmodule
`)

const legal = join(root, 'legal.v')
writeFileSync(legal, `module legal(input wire i_clk, input wire i_rst_n, input wire en, output reg [3:0] r_count, output wire o_clk, output wire busy);
wire [3:0] clkdiv;
wire [3:0] rst_cnt;
reg [3:0] r_cnt;
assign clkdiv = {3'b0, en} & r_count;
assign rst_cnt = {3'b0, en} | r_count;
assign o_clk = i_clk;
always @(posedge i_clk or negedge i_rst_n) begin
  if (!i_rst_n) begin
    r_count <= 4'b0;
    r_cnt <= 4'b0;
  end else if (en) begin
    r_count <= r_count + 1'b1;
    r_cnt <= rst_cnt + clkdiv;
  end else begin
    r_count <= r_count;
  end
end
assign busy = (r_count == 4'hf) ? 1'b1 : 1'b0;
// 注释里的 clk/rst_n 不应误报；$display 字符串同样豁免
// assign fake = clk & rst_n;
endmodule
`)

const unconventionallyNamed = join(root, 'unconventional.v')
writeFileSync(unconventionallyNamed, `module unconventional(input wire clk_50m, input wire aclk, input wire en, output wire gated, output wire gated2, output reg r_x, output reg r_y);
always @(posedge clk_50m) r_x <= en;
always @(posedge aclk) r_y <= en;
assign gated = clk_50m & en;
assign gated2 = aclk | en;
endmodule
`)

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const badAssignIssues = clkRstInCombIssues(badAssign)
check('assign 右值引用时钟报错', badAssignIssues.some((i) => i.rule === 'moonglass-no-clk-rst-in-comb' && i.message.includes('clk') && i.line === 5), JSON.stringify(badAssignIssues))
check('assign 右值引用复位报错', badAssignIssues.some((i) => i.message.includes('i_rst_n') && i.line === 6))

const badCombIssues = clkRstInCombIssues(badCombAlways)
check('always @(*) 条件引用复位报错', badCombIssues.some((i) => i.message.includes('rst_n') && i.line === 4), JSON.stringify(badCombIssues))
check('时序块敏感表与复位判断不报错', badCombIssues.length === 1, `issues=${badCombIssues.length}`)

const legalIssues = clkRstInCombIssues(legal)
check('合法时序 RTL 零误报', legalIssues.length === 0, JSON.stringify(legalIssues))

writeFileSync(join(root, 'stem_check.v'), `module stem_check(input wire clkdiv, input wire rst_cnt, input wire en, output wire a, output wire b);
assign a = clkdiv & en;
assign b = rst_cnt | en;
endmodule
`)
check('clkdiv/rst_cnt 词干不误报', clkRstInCombIssues(join(root, 'stem_check.v')).length === 0)

const unconvIssues = clkRstInCombIssues(unconventionallyNamed)
check('敏感表非常规命名时钟（clk_50m/aclk）进组合逻辑报错', unconvIssues.length === 2 && unconvIssues.every((i) => i.rule === 'moonglass-no-clk-rst-in-comb'), JSON.stringify(unconvIssues))

// 端到端：runDesignLint（verilator 联合 lint）应携带新规则 error，门禁口径一致
const design = await runDesignLint({ files: [badAssign, badCombAlways], topModule: 'bad_assign' })
check('runDesignLint 结果含新规则 error', design.errors.some((i) => i.rule === 'moonglass-no-clk-rst-in-comb'))
const clean = await runDesignLint({ files: [legal], topModule: 'legal' })
check('合法设计通过联合 lint', clean.passed, JSON.stringify(clean.errors))

console.log(failures === 0 ? '\n✅ moonglass-no-clk-rst-in-comb 冒烟通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
