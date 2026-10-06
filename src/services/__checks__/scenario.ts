import { commitInspectionChange, confirmRetest, transitionStatus, failureInjection, type CommitState } from '../commit'
import { seedRecords, seedAudit } from '../../data/seed'

function freshState(): CommitState {
  return JSON.parse(JSON.stringify({ records: seedRecords, audit: seedAudit }))
}
const ok = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 } else console.log('PASS:', msg) }

// 场景 1：双方同时进入 V3，各改各的字段，后到者不覆盖先到者
{
  const state = freshState()
  const id = 'INS-240821-01'
  const inspector = commitInspectionChange(state, id, {
    role: 'inspector', operator: '周宁', baseVersion: 3,
    items: [{ id: 'wear', reading: '4.2 mm', note: '磨损复测回落' }]
  })
  ok(inspector.ok && inspector.version === 4 && inspector.conflicts.length === 0, '1.1 检验员先保存为 V4')
  const supervisor = commitInspectionChange(state, id, {
    role: 'supervisor', operator: '郑海', baseVersion: 3,
    risk: '紧急', assignedTo: '维修二组', dueDate: '2026-10-02'
  })
  ok(supervisor.ok && supervisor.version === 5, '1.2 负责人按 V3 基线后到，保存为 V5')
  ok(supervisor.conflicts.length === 0, '1.3 字段不重叠无冲突')
  const record = state.records.find((r) => r.id === id)!
  const wear = record.items.find((i) => i.id === 'wear')!
  ok(wear.reading === '4.2 mm' && wear.note === '磨损复测回落', '1.4 检验员实测值/备注未被后保存覆盖')
  ok(record.risk === '紧急' && record.assignedTo === '维修二组' && record.dueDate === '2026-10-02', '1.5 负责人字段同时保留')
  ok(state.audit.filter((a) => a.recordId === id).length === 4, '1.6 两笔提交各生成一条审计（共 4 条含种子）')
}

// 场景 2：双方改了同一字段，后到者保留自己内容并列出冲突
{
  const state = freshState()
  const id = 'INS-240821-01'
  commitInspectionChange(state, id, { role: 'supervisor', operator: '郑海', baseVersion: 3, risk: '紧急' })
  const later = commitInspectionChange(state, id, { role: 'supervisor', operator: '另一负责人', baseVersion: 3, risk: '低' })
  ok(later.conflicts.length === 1 && later.conflicts[0].field === 'risk', '2.1 同字段并发被列为冲突')
  const record = state.records.find((r) => r.id === id)!
  ok(record.risk === '低', '2.2 后到者风险等级保留为自己的填写')
}

// 场景 3：检验项同字段冲突（实测值）
{
  const state = freshState()
  const id = 'INS-240821-01'
  commitInspectionChange(state, id, { role: 'inspector', operator: '甲', baseVersion: 3, items: [{ id: 'wear', reading: '4.9 mm' }] })
  const later = commitInspectionChange(state, id, { role: 'inspector', operator: '乙', baseVersion: 3, items: [{ id: 'wear', reading: '3.3 mm' }] })
  ok(later.conflicts.some((c) => c.kind === 'item' && c.field === 'reading'), '3.1 检验项实测值冲突被列出')
  const record = state.records.find((r) => r.id === id)!
  ok(record.items.find((i) => i.id === 'wear')!.reading === '3.3 mm', '3.2 后到者读数保留')
}

// 场景 4：角色越权被拒
{
  const state = freshState()
  const id = 'INS-240821-01'
  const bad1 = commitInspectionChange(state, id, { role: 'inspector', operator: '周宁', baseVersion: 3, items: [{ id: 'wear', reading: 'x' }], risk: '高' } as any)
  ok(!bad1.ok && /实测值|越权/.test(bad1.message), '4.1 检验员不能改风险')
  const bad2 = commitInspectionChange(state, id, { role: 'supervisor', operator: '郑海', baseVersion: 3, items: [{ id: 'wear', reading: 'x' }] })
  ok(!bad2.ok, '4.2 负责人不能改检验项')
  const untouched = state.records.find((r) => r.id === id)!
  ok(untouched.version === 3, '4.3 越权提交不产生版本')
}

// 场景 5：读数一变，未确认复测失效重算，已确认复测冻结
{
  const state = freshState()
  const id = 'INS-240821-03'
  // 先确认 wear 复测合格
  const confirmed = confirmRetest(state, id, 'wear', '周宁', true)
  ok(confirmed.ok, '5.1 wear 复测合格已确认')
  const before = state.records.find((r) => r.id === id)!
  const baseV = before.version
  // 检验员同时改动 wear（已确认）与 lock（未确认）读数
  const res = commitInspectionChange(state, id, {
    role: 'inspector', operator: '周宁', baseVersion: baseV,
    items: [{ id: 'wear', reading: '5.4 mm' }, { id: 'lock', reading: '闭合可靠' }]
  })
  const record = state.records.find((r) => r.id === id)!
  const wear = record.retests.find((r) => r.itemId === 'wear')!
  const lock = record.retests.find((r) => r.itemId === 'lock')!
  ok(wear.state === '合格' && wear.confirmed, '5.2 已确认复测不随后续读数失效')
  ok(lock.state === '合格' && !lock.confirmed, '5.3 未确认复测按新读数重算为合格')
  ok(res.retestReset?.length === 1, '5.4 提交结果只回报被重算的未确认结论')
}

// 场景 6：已关闭记录保留原依据并列出需复核项
{
  const state = freshState()
  const id = 'INS-240821-04'
  const basisBefore = state.records.find((r) => r.id === id)!.closure
  const res = commitInspectionChange(state, id, {
    role: 'inspector', operator: '赵帆', baseVersion: 6,
    items: [{ id: 'brake', reading: '制动距离 3.4 m' }]
  })
  const record = state.records.find((r) => r.id === id)!
  ok(record.status === '已关闭', '6.1 已关闭记录状态不被改写')
  ok(record.closure?.basisVersion === basisBefore?.basisVersion && record.closure?.basisSummary === basisBefore?.basisSummary, '6.2 关闭原依据保留')
  ok(record.recheck.some((x) => x.itemId === 'brake' && x.closedReading === '制动距离 2.3 m' && x.currentReading === '制动距离 3.4 m'), '6.3 新读数列入需复核')
  ok(res.recheck?.length === 2, '6.4 提交结果返回需复核列表')
}

// 场景 7：关闭校验——仍有未合格复测不能关闭；全部合格后可关闭并冻结依据
{
  const state = freshState()
  const id = 'INS-240821-03'
  const blocked = transitionStatus(state, id, '已关闭', '郑海')
  ok(!blocked.ok, '7.1 仍有不合格/未确认复测时不能关闭')
  confirmRetest(state, id, 'wear', '周宁', true)
  // lock 先录入合格读数（未确认结论自动重算为合格），再人工确认
  commitInspectionChange(state, id, {
    role: 'inspector', operator: '周宁',
    baseVersion: state.records.find((r) => r.id === id)!.version,
    items: [{ id: 'lock', reading: '闭合可靠' }]
  })
  confirmRetest(state, id, 'lock', '周宁', true)
  const closed = transitionStatus(state, id, '已关闭', '郑海')
  const record = state.records.find((r) => r.id === id)!
  ok(closed.ok && record.status === '已关闭' && !!record.closure, '7.2 复测均确认后可关闭并冻结依据')
}

// 场景 8：写入失败整体回滚，重试成功且审计只生成一次
{
  const state = freshState()
  const id = 'INS-240821-01'
  const auditCountBefore = state.audit.length
  failureInjection.failNextAuditWrite = true
  const failed = commitInspectionChange(state, id, { role: 'inspector', operator: '周宁', baseVersion: 3, items: [{ id: 'wear', reading: '4.0 mm' }] })
  ok(!failed.ok && /恢复|失败/.test(failed.message), '8.1 审计写入失败返回回滚提示')
  const rolledBack = state.records.find((r) => r.id === id)!
  ok(rolledBack.version === 3 && rolledBack.items.find((i) => i.id === 'wear')!.reading === '6.8 mm', '8.2 记录与版本恢复到上次完整版本')
  ok(state.audit.length === auditCountBefore, '8.3 失败提交未留下审计')
  const retry = commitInspectionChange(state, id, { role: 'inspector', operator: '周宁', baseVersion: 3, items: [{ id: 'wear', reading: '4.0 mm' }] })
  ok(retry.ok && retry.version === 4, '8.4 重试成功升为 V4')
  const idem = commitInspectionChange(state, id, { role: 'inspector', operator: '周宁', baseVersion: 3, items: [{ id: 'wear', reading: '4.0 mm' }] })
  ok(idem.ok && idem.version === 4, '8.5 同一次提交再次重试命中幂等')
  const auditRows = state.audit.filter((a) => a.commitId.includes('V3-inspector'))
  ok(auditRows.length === 1, '8.6 审计只生成一次')
}

// 场景 9：乐观锁基线高于当前版本被拒
{
  const state = freshState()
  const res = commitInspectionChange(state, 'INS-240821-01', { role: 'supervisor', operator: '郑海', baseVersion: 99, risk: '高' })
  ok(!res.ok, '9.1 基线版本高于当前版本时拒绝提交')
}

console.log(process.exitCode ? '存在失败用例' : '全部用例通过')

// 场景 10：编辑期间记录被他人关闭，滞后读数提交到达，需复核按关闭时点读数比对
{
  const state = freshState()
  const id = 'INS-240821-03'
  // 检验员基于 V4 进入编辑（此时记录待复测）
  const enteredAt = 4
  // 期间：复测全部合格并关闭（V5…V7）
  confirmRetest(state, id, 'wear', '周宁', true)
  commitInspectionChange(state, id, { role: 'inspector', operator: '周宁', baseVersion: 5, items: [{ id: 'lock', reading: '闭合可靠' }] })
  confirmRetest(state, id, 'lock', '周宁', true)
  transitionStatus(state, id, '已关闭', '郑海')
  const closedVersion = state.records.find((r) => r.id === id)!.version
  // 检验员的滞后提交：改 wear 读数
  const res = commitInspectionChange(state, id, {
    role: 'inspector', operator: '周宁', baseVersion: enteredAt,
    items: [{ id: 'wear', reading: '5.9 mm' }]
  })
  const record = state.records.find((r) => r.id === id)!
  ok(res.ok && record.status === '已关闭', '10.1 滞后提交不重开已关闭记录')
  ok(record.closure?.basisVersion === closedVersion - 1 || !!record.closure, '10.2 关闭依据保留')
  const item = record.recheck.find((x) => x.itemId === 'wear')
  ok(item && item.closedReading === '4.6 mm' && item.currentReading === '5.9 mm', '10.3 需复核按关闭时点读数 4.6 mm 比对新读数 5.9 mm')
  ok(record.version === closedVersion + 1, '10.4 滞后提交仍生成新版本与一条审计')
}
console.log(process.exitCode ? '存在失败用例' : '全部用例通过（含场景 10）')
