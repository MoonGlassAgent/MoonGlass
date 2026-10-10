// 提取真实服务方法，在临时工程测试启动与 W0 派发，不调用模型或修改用户工程。
import assert from 'node:assert/strict'
import {register} from 'node:module'
import {readFileSync, mkdtempSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import ts from 'typescript'
register('./ts-alias-hooks.mjs', import.meta.url)
const core = await import('../src/main/services/verif-run-loop.ts')
const source = readFileSync('src/main/services/AgentService.ts', 'utf8')
const ast = ts.createSourceFile('AgentService.ts', source, ts.ScriptTarget.Latest, true)
const service = ast.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'AgentService')
const names = ['patchRunLoopLedger','startVerifRunLoop','kickRunLoop','runVerifRunLoopBeats']
const methods = names.map(name => {
  const member = service.members.find(m => m.name?.getText(ast) === name)
  assert.ok(member, name)
  return member.getText(ast)
}).join('\n')
let failWrite = false, missingLedger = false
const dependencies = {
  ...core,
  updateVerifRunLoopLedger: (...args) => {
    if (failWrite) throw new Error('EPERM: test write denied')
    return core.updateVerifRunLoopLedger(...args)
  },
  readVerifRunLoopLedger: root => missingLedger ? null : core.readVerifRunLoopLedger(root),
  nextRunnableDecision: () => null,
  rtlFixGateReason: () => null,
  // 模块 UT 互斥门控（MODULE-UT §4）：本 smoke 不涉及 UT，恒放行（门控本身由 module-ut-smoke 覆盖）
  moduleUtRunLoopGateReason: () => null,
  reconcileVerificationWork: () => {},
  readVerificationWork: () => ({work:[]}),
  blockedVerificationScenarios: () => new Set(),
  appendRunLoopRuleDecision: () => ({id:'test-rule'}),
  console: {log(){},warn(){},error(){}}
}
const js = ts.transpileModule('class Probe {'+methods+'}', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
const Probe = new Function(...Object.keys(dependencies), js+';return Probe')(...Object.values(dependencies))
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'moonglass-start-test-'))
  const probe = new Probe(), events = [], tasks = []
  Object.assign(probe, {
    projects:new Map([['P',{currentPhase:'VERIF'}]]),
    verifRunLoops:new Map(), verifRunLoopGeneration:new Map(),
    verifRunLoopStopRequested:new Set(), verifRunLoopPauseRequested:new Set(),
    activeRtlFixes:new Map(), workspaceDir:()=>root,
    readyProviders:()=>[{}], stopRunLoopEvidencePoller:()=>{}, notifyRtlFixWaiters:()=>{},
    emit:(_p,e)=>events.push(e),
    dispatchRunLoopTaskSession:async (_p,title,prompt)=>{
      tasks.push({title,prompt})
      probe.verifRunLoopStopRequested.add('P')
      return {verdict:'settled',tokensUsed:0}
    },
    // 拍回填在拍循环尾部被调用（recordRunLoopBeat → decision outcome → emit），
    // 不在本测试的提取方法集内，mock 为 no-op；其内部写账由 verif-run-loop-smoke 覆盖
    recordRunLoopBeatResult:()=>{}
  })
  return {root,probe,events,tasks}
}
// 首次进入 VERIF、无 verification 目录：必须建立账本并真正派发原有 W0 规划。
// 注意：句柄须在 await 前同步捕获——mock 派发瞬间 settle，循环可能在 await start 返回前已完成并清理句柄
const first = fixture()
const firstStarted = first.probe.startVerifRunLoop('P')
const firstHandle = first.probe.verifRunLoops.get('P')?.promise
await firstStarted
if (firstHandle) await firstHandle
assert.equal(first.tasks.length,1)
assert.equal(first.tasks[0].prompt,core.VERIF_RUN_LOOP_PLANNING_PROMPT)
assert.equal(first.probe.verifRunLoops.size,0)
assert.equal(core.readVerifRunLoopLedger(first.root).state,'stopped')
// 旧代际残留或不一致，新的启动必须成功落新账本，而不是被旧守卫拒绝。
const restart = fixture()
core.updateVerifRunLoopLedger(restart.root,l=>{l.state='stopped';l.loopId='disk-old'})
restart.probe.verifRunLoopGeneration.set(restart.root,'memory-old')
const restartStarted = restart.probe.startVerifRunLoop('P')
const restartHandle = restart.probe.verifRunLoops.get('P')?.promise
await restartStarted
if (restartHandle) await restartHandle
assert.equal(restart.tasks.length,1)
assert.notEqual(core.readVerifRunLoopLedger(restart.root).loopId,'disk-old')
// 写入失败必须拒绝启动，不能发成功事件或留下运行句柄。
const denied = fixture()
failWrite = true
await assert.rejects(()=>denied.probe.startVerifRunLoop('P'),/EPERM/)
assert.throws(()=>denied.probe.patchRunLoopLedger(denied.root,()=>{}),/账本写入失败/)
assert.equal(denied.events.some(e=>e.message.includes('循环已启动')),false)
assert.equal(denied.probe.verifRunLoops.size,0)
failWrite = false
// 循环中账本不可读且异常状态也无法写入：仍须通知界面并清理句柄。
const lost = fixture()
const started = lost.probe.startVerifRunLoop('P')
const running = lost.probe.verifRunLoops.get('P').promise
missingLedger = true
failWrite = true
await started
await running
assert.equal(lost.tasks.length,0)
assert.ok(lost.events.some(e=>e.message.includes('异常熔断')&&e.message.includes('不可读取')))
assert.equal(lost.probe.verifRunLoops.size,0)
missingLedger = false
failWrite = false
// 对真实文件系统错误也拒绝，而非仅依赖注入错误。
const badPath = fixture()
const file = join(badPath.root,'not-a-directory')
writeFileSync(file,'test')
badPath.probe.workspaceDir = ()=>file
await assert.rejects(()=>badPath.probe.startVerifRunLoop('P'))
assert.equal(badPath.probe.verifRunLoops.size,0)
console.log('verif-run-loop-start-smoke: OK (real W0 dispatch, restart generation, write failure, lost ledger, handle cleanup)')
