import type {
  AuditEntry,
  ClosureVerdict,
  EditRole,
  FieldConflict,
  InspectionItem,
  InspectionRecord,
  InspectionStatus,
  RecheckItem,
  RetestVerdict
} from '../types'

/** 检验员可写字段（仅实测值与备注） */
const INSPECTOR_ITEM_FIELDS = ['reading', 'note'] as const
/** 值班负责人可写字段（风险、责任人、截止日期、停用隔离） */
const SUPERVISOR_SCALAR_FIELDS = ['risk', 'assignedTo', 'dueDate', 'stopped'] as const

const FIELD_LABELS: Record<string, string> = {
  reading: '实测值',
  note: '备注',
  risk: '风险等级',
  assignedTo: '整改责任人',
  dueDate: '截止日期',
  stopped: '设备状态'
}

export interface CommitState {
  records: InspectionRecord[]
  audit: AuditEntry[]
}

export interface CommitChange {
  role: EditRole
  operator: string
  /** 进入编辑时看到的版本号，乐观锁以它为准 */
  baseVersion: number
  items?: Array<Pick<InspectionItem, 'id'> & Partial<Pick<InspectionItem, 'reading' | 'note'>>>
  risk?: InspectionRecord['risk']
  assignedTo?: string
  dueDate?: string
  stopped?: boolean
}

export interface CommitResult {
  ok: boolean
  message: string
  version?: number
  conflicts: FieldConflict[]
  recheck?: RecheckItem[]
  retestReset?: RetestVerdict[]
}

/**
 * 读数判定：用于复测未确认结论的重算。
 * 检验项 result 保留原始发现，复测是否合格只看当前读数是否满足限值。
 */
function evaluateReading(item: InspectionItem): RetestVerdict['state'] {
  const reading = item.reading.trim()
  if (!reading || reading === '待录入') return '待复测'
  if (item.result === '不适用') return '合格'
  const limitMatch = item.limit.match(/≤\s*([\d.]+)/)
  const readingMatch = reading.match(/([\d.]+)/)
  if (limitMatch && readingMatch) {
    const limitValue = Number(limitMatch[1])
    const readingValue = Number(readingMatch[1])
    if (Number.isFinite(limitValue) && Number.isFinite(readingValue)) {
      return readingValue <= limitValue ? '合格' : '不合格'
    }
  }
  const negative = /超|间隙|异响|失效|不可靠|不合格/
  return negative.test(reading) ? '不合格' : '合格'
}

function nowText() {
  return new Date().toISOString()
}

/** 提交 ID：同一次提交的重试内容完全一致，据此让审计只生成一次 */
function commitIdOf(recordId: string, change: CommitChange) {
  const payload = JSON.stringify([
    change.items ?? [],
    change.risk ?? null,
    change.assignedTo ?? null,
    change.dueDate ?? null,
    change.stopped ?? null
  ])
  let hash = 0
  for (let index = 0; index < payload.length; index += 1) {
    hash = (hash * 31 + payload.charCodeAt(index)) >>> 0
  }
  return `CMT-${recordId}-V${change.baseVersion}-${change.role}-${hash.toString(36)}`
}

/** 事务快照：记录、版本、审计一次性回滚到上次完整版本 */
function withTransaction<T>(state: CommitState, recordId: string, run: (record: InspectionRecord, base: InspectionRecord, time: string) => T): T | undefined {
  const index = state.records.findIndex((item) => item.id === recordId)
  if (index < 0) return undefined
  const snapshot = structuredClone({ records: state.records, audit: state.audit })
  const record = state.records[index]
  const base = structuredClone(record)
  try {
    return run(record, base, nowText())
  } catch (error) {
    state.records.splice(0, state.records.length, ...snapshot.records)
    state.audit.splice(0, state.audit.length, ...snapshot.audit)
    throw error
  }
}

/** 演示用故障注入：置位后下一次审计写入抛错，以验证整笔事务回滚与重试幂等 */
export const failureInjection = { failNextAuditWrite: false }

function insertAudit(state: CommitState, entry: AuditEntry) {
  if (failureInjection.failNextAuditWrite) {
    failureInjection.failNextAuditWrite = false
    throw new Error('审计通道暂不可用（模拟故障）')
  }
  state.audit.unshift(entry)
}

/** 复测依赖的读数发生变化：未确认结论失效重算，已确认结论冻结 */
function recomputeRetests(record: InspectionRecord, changedItemIds: Set<string>, nextVersion: number) {
  const reset: RetestVerdict[] = []
  if (!record.retests.length) return reset
  const time = nowText()
  for (const verdict of record.retests) {
    if (verdict.confirmed || !changedItemIds.has(verdict.itemId)) continue
    const item = record.items.find((candidate) => candidate.id === verdict.itemId)
    if (!item) continue
    const state = evaluateReading(item)
    if (state === verdict.state && verdict.reading === item.reading) continue
    Object.assign(verdict, { state, reading: item.reading, basisVersion: nextVersion, updatedAt: time })
    reset.push(verdict)
  }
  return reset
}

/** 已关闭记录保留原依据，被修正的读数追加到需复核列表 */
function collectRecheck(record: InspectionRecord, changedItemIds: Set<string>, nextVersion: number) {
  const known = new Set(record.recheck.map((item) => item.itemId))
  const closedReadings = record.closure?.itemReadings ?? {}
  for (const item of record.items) {
    if (!changedItemIds.has(item.id) || known.has(item.id)) continue
    const closedReading = closedReadings[item.id] ?? item.reading
    if (closedReading !== item.reading) {
      record.recheck.push({
        itemId: item.id,
        itemName: item.name,
        closedReading,
        currentReading: item.reading,
        sinceVersion: nextVersion
      })
    }
  }
}

function assertRoleAllowed(change: CommitChange) {
  if (change.role === 'supervisor') {
    if (change.items) throw new Error('值班负责人不能修改检验项实测值与备注')
    return
  }
  // 检验员只能携带检验项的实测值/备注，任何处置字段都视为越权
  const scalarKeys = SUPERVISOR_SCALAR_FIELDS.filter((field) => (change as unknown as Record<string, unknown>)[field] !== undefined)
  if (scalarKeys.length) {
    throw new Error(`检验员只能修改实测值和备注，越权字段：${scalarKeys.map((key) => FIELD_LABELS[key]).join('、')}`)
  }
  if (change.items) {
    for (const item of change.items) {
      const extra = Object.keys(item).filter((key) => key !== 'id' && !(INSPECTOR_ITEM_FIELDS as readonly string[]).includes(key))
      if (extra.length) throw new Error(`检验员只能修改实测值和备注，越权字段：${extra.join('、')}`)
    }
  }
}

/** 取进入编辑时的完整版本作为三方合并基线；找不到则用当前记录兜底 */
function baseSnapshotOf(record: InspectionRecord, baseVersion: number): InspectionRecord {
  if (record.version === baseVersion) return structuredClone(record)
  const hit = record.snapshots?.find((snapshot) => snapshot.version === baseVersion)
  if (hit) return structuredClone(hit)
  // 退回最接近且不晚于基线的版本
  const earlier = record.snapshots
    ?.filter((snapshot) => snapshot.version <= baseVersion)
    .sort((a, b) => b.version - a.version)[0]
  return earlier ? structuredClone(earlier) : structuredClone(record)
}

/**
 * 把一次提交原子地落到“检验项 + 记录版本 + 操作审计”上。
 * - 乐观锁：双方都按进入编辑时的版本检查；版本落后做字段级三方合并不整体覆盖
 * - 后到者保留自己的填写内容，同一字段被双方先后改动时列出冲突
 * - 复测依赖的读数一变，未确认复测结论失效重算；已关闭记录保留原依据并列需复核项
 * - 写入失败恢复到上次完整版本；重试沿用同一提交 ID，审计不重复生成
 */
export function commitInspectionChange(state: CommitState, recordId: string, change: CommitChange): CommitResult {
  try {
    assertRoleAllowed(change)
  } catch (error) {
    return { ok: false, message: (error as Error).message, conflicts: [] }
  }

  const commitId = commitIdOf(recordId, change)
  const record = state.records.find((item) => item.id === recordId)
  if (!record) return { ok: false, message: '检验记录不存在', conflicts: [] }

  // 幂等：同一次提交的重试直接命中，不再改写记录也不重复生成审计
  if (record.lastCommitId === commitId && state.audit.some((entry) => entry.commitId === commitId)) {
    return {
      ok: true,
      message: `提交此前已生效（V${record.version}），重试未重复生成审计`,
      version: record.version,
      conflicts: []
    }
  }

  if (change.baseVersion > record.version) {
    return { ok: false, message: `基线版本 V${change.baseVersion} 高于当前 V${record.version}，请刷新后重试`, conflicts: [] }
  }

  // 无变更短路：相对进入编辑版本没有任何改动时不升版本、不写审计
  const editBase = baseSnapshotOf(record, change.baseVersion)
  const hasItemChange = change.items?.some((patch) => INSPECTOR_ITEM_FIELDS.some((field) => {
    const incoming = patch[field]
    if (incoming === undefined) return false
    const baseItem = editBase.items.find((item) => item.id === patch.id)
    return baseItem ? incoming !== baseItem[field] : true
  }))
  const hasScalarChange = SUPERVISOR_SCALAR_FIELDS.some((field) => {
    const incoming = change[field]
    return incoming !== undefined && incoming !== editBase[field]
  })
  if (!hasItemChange && !hasScalarChange) {
    return { ok: true, message: '内容与进入编辑时一致，无需要保存的修改', version: record.version, conflicts: [] }
  }

  try {
    const outcome = withTransaction(state, recordId, (target, _currentBase, time) => {
      // 三方合并基线 = 进入编辑时看到的完整版本，而非库内当前版本
      const base = baseSnapshotOf(target, change.baseVersion)
      // 检验员/负责人提交不改状态，是否已关闭以库内当前状态为准
      const isClosed = target.status === '已关闭'
      const conflicts: FieldConflict[] = []
      const changedItemIds = new Set<string>()
      const nextVersion = target.version + 1

      // 先保存库内当前完整版本（尚未应用本次修改），供后来者按其进入编辑版本三方合并
      const previousSnapshot = structuredClone({ ...target, snapshots: [] })
      target.snapshots = [...(target.snapshots ?? []).filter((snapshot) => snapshot.version !== previousSnapshot.version), previousSnapshot].slice(-10)

      // —— 检验员字段：逐项与库内当前版本三方对比 ——
      if (change.items) {
        for (const patch of change.items) {
          const baseItem = base.items.find((item) => item.id === patch.id)
          const currentItem = target.items.find((item) => item.id === patch.id)
          if (!baseItem || !currentItem) continue
          for (const field of INSPECTOR_ITEM_FIELDS) {
            const incoming = patch[field]
            if (incoming === undefined || incoming === baseItem[field]) continue
            changedItemIds.add(patch.id)
            // 先到者已改过同字段：冲突留痕，但值仍以后到者本次提交为准
            if (baseItem[field] !== currentItem[field] && incoming !== currentItem[field]) {
              conflicts.push({
                kind: 'item',
                field,
                label: FIELD_LABELS[field],
                itemId: patch.id,
                itemName: baseItem.name,
                baseValue: baseItem[field],
                incomingValue: incoming,
                currentValue: currentItem[field],
                resolution: '保留本次提交'
              })
            }
            currentItem[field] = incoming
          }
        }
      }

      // —— 负责人字段：风险、责任人、截止日期、停用隔离 ——
      for (const field of SUPERVISOR_SCALAR_FIELDS) {
        const incoming = change[field]
        if (incoming === undefined || incoming === base[field]) continue
        if (base[field] !== target[field] && incoming !== target[field]) {
          conflicts.push({
            kind: 'scalar',
            field,
            label: FIELD_LABELS[field],
            baseValue: String(base[field]),
            incomingValue: String(incoming),
            currentValue: String(target[field]),
            resolution: '保留本次提交'
          })
        }
        ;(target as unknown as Record<string, unknown>)[field] = incoming
      }

      const reset = recomputeRetests(target, changedItemIds, nextVersion)
      if (isClosed && changedItemIds.size) {
        collectRecheck(target, changedItemIds, nextVersion)
      }

      target.version = nextVersion
      target.updatedAt = time
      target.lastCommitId = commitId

      const changedLabels: string[] = []
      if (changedItemIds.size) changedLabels.push(`检验项 ${changedItemIds.size} 项（实测值/备注）`)
      for (const field of SUPERVISOR_SCALAR_FIELDS) {
        if (change[field] !== undefined && change[field] !== base[field]) changedLabels.push(FIELD_LABELS[field])
      }
      const detailParts = [
        `V${base.version} → V${target.version}`,
        `按进入编辑版本 V${change.baseVersion} 校验`,
        `修改：${changedLabels.join('、') || '无变更'}`
      ]
      if (conflicts.length) detailParts.push(`并发冲突 ${conflicts.length} 处，后到者内容已保留，冲突字段：${conflicts.map((item) => item.itemName ? `${item.itemName}${item.label}` : item.label).join('、')}`)
      if (reset.length) detailParts.push(`依赖读数变化，未确认复测结论 ${reset.length} 项失效重算`)
      if (isClosed && changedItemIds.size) detailParts.push('记录已关闭，原关闭依据保留，新读数列入需复核项')

      insertAudit(state, {
        id: `${recordId}-${commitId}`,
        commitId,
        recordId,
        action: change.role === 'inspector' ? '检验员提交实测值' : '值班负责人提交处置',
        operator: change.operator,
        detail: detailParts.join('；'),
        createdAt: time
      })

      return { conflicts, reset, closed: isClosed && changedItemIds.size > 0 }
    })
    if (!outcome) return { ok: false, message: '检验记录不存在', conflicts: [] }

    const saved = state.records.find((item) => item.id === recordId)!
    return {
      ok: true,
      message: outcome.conflicts.length
        ? `已保存为 V${saved.version}，${outcome.conflicts.length} 处并发冲突已保留你的填写，请核对冲突字段`
        : `已保存为 V${saved.version}`,
      version: saved.version,
      conflicts: outcome.conflicts,
      recheck: outcome.closed ? saved.recheck : undefined,
      retestReset: outcome.reset.length ? outcome.reset : undefined
    }
  } catch (error) {
    // withTransaction 已把记录、版本、审计整体恢复到上次完整版本
    return {
      ok: false,
      message: `写入失败，已从上次完整版本恢复，可安全重试：${(error as Error).message}`,
      conflicts: []
    }
  }
}

/** 检验员确认复测结论；确认后冻结，读数再变也不自动改写 */
export function confirmRetest(state: CommitState, recordId: string, itemId: string, operator: string, pass: boolean): CommitResult {
  const record = state.records.find((item) => item.id === recordId)
  if (!record) return { ok: false, message: '检验记录不存在', conflicts: [] }
  const verdict = record.retests.find((item) => item.itemId === itemId)
  if (!verdict) return { ok: false, message: '没有对应的复测结论', conflicts: [] }

  const commitId = `CMT-RT-${recordId}-V${record.version}-${itemId}-${pass ? 1 : 0}`
  if (record.lastCommitId === commitId && state.audit.some((entry) => entry.commitId === commitId)) {
    return { ok: true, message: '复测确认此前已生效，重试未重复生成审计', version: record.version, conflicts: [] }
  }

  try {
    withTransaction(state, recordId, (target, base, time) => {
      const previousSnapshot = structuredClone({ ...target, snapshots: [] })
      target.snapshots = [...(target.snapshots ?? []).filter((snapshot) => snapshot.version !== previousSnapshot.version), previousSnapshot].slice(-10)
      const targetVerdict = target.retests.find((item) => item.itemId === itemId)!
      Object.assign(targetVerdict, {
        state: pass ? '合格' : '不合格',
        confirmed: true,
        basisVersion: base.version + 1,
        updatedAt: time
      })
      target.version = base.version + 1
      target.updatedAt = time
      target.lastCommitId = commitId
      insertAudit(state, {
        id: `${recordId}-${commitId}`,
        commitId,
        recordId,
        action: pass ? '复测合格确认' : '复测不合格确认',
        operator,
        detail: `V${base.version} → V${target.version}；${targetVerdict.itemName} 复测${pass ? '合格' : '不合格'}，结论已确认冻结`,
        createdAt: time
      })
    })
    const saved = state.records.find((item) => item.id === recordId)!
    return { ok: true, message: `复测结论已确认（${pass ? '合格' : '不合格'}）`, version: saved.version, conflicts: [] }
  } catch (error) {
    return { ok: false, message: `写入失败，已恢复到上次完整版本：${(error as Error).message}`, conflicts: [] }
  }
}

export interface TransitionResult {
  ok: boolean
  message: string
}

/** 状态流转同样与版本、审计同一次提交；待复测生成未确认结论，关闭冻结依据 */
export function transitionStatus(state: CommitState, recordId: string, next: InspectionStatus, operator: string, detail?: string): TransitionResult {
  const record = state.records.find((item) => item.id === recordId)
  if (!record) return { ok: false, message: '记录不存在' }

  if (next === '已关闭') {
    // 异常项只要存在合格复测结论即视为闭环；无复测结论或结论未合格则禁止关闭
    const outstanding = record.items.filter((item) => {
      if (item.result !== '异常') return false
      return record.retests.find((verdict) => verdict.itemId === item.id)?.state !== '合格'
    })
    if (outstanding.length) {
      return { ok: false, message: `仍有 ${outstanding.length} 个异常项未取得合格复测结论，不能关闭任务` }
    }
  }
  if (next === '待复测' && !record.stopped && record.risk === '紧急') {
    return { ok: false, message: '紧急风险缺陷必须先执行停用' }
  }

  const commitId = `CMT-ST-${recordId}-V${record.version}-${next}`
  try {
    withTransaction(state, recordId, (target, base, time) => {
      const previousSnapshot = structuredClone({ ...target, snapshots: [] })
      target.snapshots = [...(target.snapshots ?? []).filter((snapshot) => snapshot.version !== previousSnapshot.version), previousSnapshot].slice(-10)
      target.status = next
      if (next === '待复测') {
        // 为异常项建立未确认复测结论，依据当前读数重算
        for (const item of target.items.filter((candidate) => candidate.result === '异常')) {
          if (target.retests.some((verdict) => verdict.itemId === item.id)) continue
          target.retests.push({
            itemId: item.id,
            itemName: item.name,
            state: evaluateReading(item),
            reading: item.reading,
            basisVersion: base.version + 1,
            confirmed: false,
            updatedAt: time
          })
        }
      }
      if (next === '已关闭') {
        target.closure = buildClosureAt(base.version + 1, target, time)
      }
      target.version = base.version + 1
      target.updatedAt = time
      target.lastCommitId = commitId
      insertAudit(state, {
        id: `${recordId}-${commitId}`,
        commitId,
        recordId,
        action: `状态流转：${next}`,
        operator,
        detail: detail ?? `由${base.status}流转至${next}（V${base.version} → V${target.version}）`,
        createdAt: time
      })
    })
    return { ok: true, message: `已流转至${next}` }
  } catch (error) {
    return { ok: false, message: `流转失败，已恢复到上次完整版本：${(error as Error).message}` }
  }
}

function buildClosureAt(version: number, record: InspectionRecord, time: string): ClosureVerdict {
  const abnormal = record.items.filter((item) => item.result === '异常')
  return {
    state: '已关闭',
    basisVersion: version,
    basisSummary: abnormal.length
      ? `关闭时异常项 ${abnormal.length} 个均已复测合格：${abnormal.map((item) => item.name).join('、')}`
      : `关闭时全部 ${record.items.length} 个检验项正常`,
    itemReadings: Object.fromEntries(record.items.map((item) => [item.id, item.reading])),
    confirmed: true,
    closedAt: time
  }
}
