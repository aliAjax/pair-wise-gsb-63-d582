import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedRecords } from '../data/seed'
import { createOfflineInspection } from '../services/api'
import type {
  AuditEntry,
  CheckResult,
  CommitPatch,
  CommitResult,
  EditorRole,
  FieldChange,
  InspectionDraft,
  InspectionRecord,
  InspectionStatus
} from '../types'

const STORAGE_KEY = 'gsb63:inspection-platform'
const HISTORY_LIMIT = 20
const TX_LIMIT = 100

interface CommittedTx {
  version: number
  conflicts: FieldChange[]
}

interface PersistedState {
  records: InspectionRecord[]
  audit: AuditEntry[]
  history: Record<string, InspectionRecord[]>
  committed: Record<string, CommittedTx>
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function seedState(): PersistedState {
  const records = clone(seedRecords)
  const history: Record<string, InspectionRecord[]> = {}
  for (const record of records) history[record.id] = [clone(record)]
  return { records, audit: clone(seedAudit), history, committed: {} }
}

function readPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return seedState()
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    if (!parsed.records) return seedState()
    return {
      records: parsed.records,
      audit: parsed.audit ?? [],
      history: parsed.history ?? {},
      committed: parsed.committed ?? {}
    }
  } catch {
    return seedState()
  }
}

export function genTxId(): string {
  return `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function deriveResult(reading: string, limit: string): CheckResult | null {
  const valueMatch = reading.match(/-?\d+(?:\.\d+)?/)
  const boundMatch = limit.match(/(≤|<=|≥|>=|<|>)\s*(-?\d+(?:\.\d+)?)/)
  if (!valueMatch || !boundMatch) return null
  const value = Number(valueMatch[0])
  const threshold = Number(boundMatch[2])
  const op = boundMatch[1]
  const pass = op === '≤' || op === '<='
    ? value <= threshold
    : op === '<'
      ? value < threshold
      : op === '≥' || op === '>='
        ? value >= threshold
        : value > threshold
  return pass ? '正常' : '异常'
}

function diffRecords(base: InspectionRecord, current: InspectionRecord): FieldChange[] {
  const changes: FieldChange[] = []
  const scalars: Array<{ key: 'risk' | 'assignedTo' | 'dueDate' | 'status'; label: string }> = [
    { key: 'risk', label: '风险等级' },
    { key: 'assignedTo', label: '整改责任人' },
    { key: 'dueDate', label: '截止日期' },
    { key: 'status', label: '流程状态' }
  ]
  for (const { key, label } of scalars) {
    if (base[key] !== current[key]) {
      changes.push({ field: key, label, before: String(base[key]), after: String(current[key]) })
    }
  }
  if (base.stopped !== current.stopped) {
    changes.push({ field: 'stopped', label: '设备状态', before: base.stopped ? '停用隔离' : '正常开放', after: current.stopped ? '停用隔离' : '正常开放' })
  }
  for (const item of current.items) {
    const prev = base.items.find((entry) => entry.id === item.id)
    if (!prev) continue
    if (prev.reading !== item.reading) changes.push({ field: `${item.id}.reading`, label: `${item.name}·实测值`, before: prev.reading, after: item.reading })
    if (prev.note !== item.note) changes.push({ field: `${item.id}.note`, label: `${item.name}·备注`, before: prev.note || '（空）', after: item.note || '（空）' })
    if (prev.result !== item.result) changes.push({ field: `${item.id}.result`, label: `${item.name}·结果`, before: prev.result, after: item.result })
  }
  return changes
}

export const useInspectionStore = defineStore('inspection', () => {
  const initial = readPersisted()
  const records = ref<InspectionRecord[]>(initial.records)
  const audit = ref<AuditEntry[]>(initial.audit)
  const history = ref<Record<string, InspectionRecord[]>>(initial.history)
  const committed = ref<Record<string, CommittedTx>>(initial.committed)
  const currentRole = ref<EditorRole>('inspector')
  const simulateFailure = ref(false)
  const keyword = ref('')
  const status = ref<InspectionStatus | '全部'>('全部')
  const area = ref('全部')
  const liveMessage = ref('本地实时通道已就绪')

  const filtered = computed(() => records.value.filter((record) => {
    const haystack = `${record.id} ${record.deviceCode} ${record.deviceName} ${record.inspector} ${record.assignedTo}`.toLowerCase()
    return (!keyword.value || haystack.includes(keyword.value.toLowerCase()))
      && (status.value === '全部' || record.status === status.value)
      && (area.value === '全部' || record.area === area.value)
  }))

  const stats = computed(() => ({
    total: records.value.length,
    blocked: records.value.filter((item) => item.stopped).length,
    overdue: records.value.filter((item) => item.dueDate < '2026-09-29' && !['已关闭'].includes(item.status)).length,
    closed: records.value.filter((item) => item.status === '已关闭').length
  }))

  function persist(state: PersistedState) {
    if (simulateFailure.value) {
      simulateFailure.value = false
      throw new Error('模拟写入失败')
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }

  // 同一次提交：检验项、记录版本、操作审计作为一个整体先落库，
  // 持久化成功后才替换内存状态；写入失败时内存仍停留在上次完整版本。
  function applyCommit(nextRecord: InspectionRecord, entry: AuditEntry, tx?: { txId: string; conflicts: FieldChange[] }): CommitResult {
    const index = records.value.findIndex((item) => item.id === nextRecord.id)
    const nextRecords = index >= 0 ? records.value.slice() : [nextRecord, ...records.value]
    if (index >= 0) nextRecords[index] = nextRecord
    const nextAudit = [entry, ...audit.value]
    const existing = history.value[nextRecord.id] ?? []
    const previous = index >= 0 ? records.value[index] : null
    const withBase = previous && !existing.some((snap) => snap.version === previous.version)
      ? [...existing, clone(previous)]
      : existing
    const nextHistory = { ...history.value, [nextRecord.id]: [...withBase, clone(nextRecord)].slice(-HISTORY_LIMIT) }
    let nextCommitted = committed.value
    if (tx) {
      const entries = Object.entries(committed.value)
      entries.push([tx.txId, { version: nextRecord.version, conflicts: tx.conflicts }])
      nextCommitted = Object.fromEntries(entries.slice(-TX_LIMIT))
    }
    try {
      persist({ records: nextRecords, audit: nextAudit, history: nextHistory, committed: nextCommitted })
    } catch {
      return { ok: false, retryable: true, message: '写入失败，已恢复至上次完整版本' }
    }
    records.value = nextRecords
    audit.value = nextAudit
    history.value = nextHistory
    committed.value = nextCommitted
    return { ok: true, version: nextRecord.version, message: '已提交' }
  }

  function operatorOf(role: EditorRole, record: InspectionRecord) {
    return role === 'inspector' ? record.inspector : '陈岚'
  }

  function commitUpdate(id: string, role: EditorRole, patch: CommitPatch, baseVersion: number, txId: string, options: { action?: string } = {}): CommitResult {
    const replay = committed.value[txId]
    if (replay) {
      return { ok: true, deduplicated: true, version: replay.version, conflicts: replay.conflicts, invalidated: [], message: '该提交已落库，重试未重复生成审计' }
    }
    const current = records.value.find((item) => item.id === id)
    if (!current) return { ok: false, message: '记录不存在' }

    // 乐观并发：按进入编辑时的版本检查，后到者保留自己的填写
    let conflicts: FieldChange[] = []
    if (current.version !== baseVersion) {
      const base = (history.value[id] ?? []).find((snap) => snap.version === baseVersion)
      conflicts = base
        ? diffRecords(base, current)
        : [{ field: 'version', label: '记录版本', before: `V${baseVersion}`, after: `V${current.version}` }]
    }

    const next = clone(current)
    const changed: string[] = []
    const readingChanged: Array<{ id: string; name: string }> = []

    if (role === 'inspector') {
      // 检验员只允许写实测值和备注
      for (const itemPatch of patch.items ?? []) {
        const item = next.items.find((entry) => entry.id === itemPatch.id)
        if (!item) continue
        if (itemPatch.reading !== undefined && itemPatch.reading !== item.reading) {
          item.reading = itemPatch.reading
          readingChanged.push({ id: item.id, name: item.name })
          changed.push(`${item.name}·实测值`)
        }
        if (itemPatch.note !== undefined && itemPatch.note !== item.note) {
          item.note = itemPatch.note
          changed.push(`${item.name}·备注`)
        }
      }
      // 读数变化后按判定标准重算结果
      for (const stale of readingChanged) {
        const item = next.items.find((entry) => entry.id === stale.id)
        if (!item) continue
        const derived = deriveResult(item.reading, item.limit)
        if (derived && derived !== item.result) {
          item.result = derived
          changed.push(`${item.name}·结果`)
        }
      }
    } else {
      // 负责人只允许写风险、责任人和截止日期
      if (patch.risk !== undefined && patch.risk !== next.risk) { next.risk = patch.risk; changed.push('风险等级') }
      if (patch.assignedTo !== undefined && patch.assignedTo !== next.assignedTo) { next.assignedTo = patch.assignedTo; changed.push('整改责任人') }
      if (patch.dueDate !== undefined && patch.dueDate !== next.dueDate) { next.dueDate = patch.dueDate; changed.push('截止日期') }
    }

    if (!changed.length) {
      return { ok: true, version: current.version, conflicts, invalidated: [], message: '没有需要保存的变更' }
    }

    // 复测依赖的读数一变：未确认复测与关闭结论失效重算
    const invalidated: string[] = []
    if (readingChanged.length) {
      const names = readingChanged.map((item) => item.name)
      if (next.status === '待复测') {
        const abnormal = next.items.filter((item) => item.result === '异常')
        if (abnormal.length) {
          next.status = '整改中'
          invalidated.push(`复测依赖的读数变更（${names.join('、')}），复测结论失效，仍有 ${abnormal.length} 项异常，退回整改中`)
        } else {
          invalidated.push(`复测依赖的读数变更（${names.join('、')}），复测结论已按新读数重算`)
        }
      } else if (next.status === '已关闭') {
        if (!next.closureBasis) {
          next.closureBasis = { closedAt: current.updatedAt, version: current.version, items: clone(current.items) }
        }
        next.reviewItems = [...new Set([...(next.reviewItems ?? []), ...names])]
        invalidated.push(`关闭记录读数变更（${names.join('、')}），原关闭依据保留，已列入需复核项`)
      }
    }

    next.version = current.version + 1
    next.updatedAt = new Date().toISOString()

    const detailParts = [`变更字段：${changed.join('、')}`]
    if (conflicts.length) {
      detailParts.push(`并发冲突：基于 V${baseVersion} 编辑，保存时记录已为 V${current.version}，对方修改了 ${conflicts.map((item) => item.label).join('、')}，本次保留你的填写`)
    }
    detailParts.push(...invalidated)

    const entry: AuditEntry = {
      id: `${id}-${txId}`,
      recordId: id,
      action: options.action ?? (conflicts.length ? '合并保存（并发冲突）' : role === 'inspector' ? '检验员保存实测值' : '负责人保存处置信息'),
      operator: operatorOf(role, current),
      role,
      detail: detailParts.join('；'),
      version: next.version,
      txId,
      fields: changed,
      createdAt: next.updatedAt
    }

    const result = applyCommit(next, entry, { txId, conflicts })
    if (!result.ok) return { ok: false, retryable: true, message: result.message }
    return {
      ok: true,
      version: next.version,
      conflicts,
      invalidated,
      message: conflicts.length ? '已保留你的填写并合并保存' : `已保存，记录版本 V${next.version}`
    }
  }

  function transition(id: string, nextStatus: InspectionStatus, detail: string) {
    const record = records.value.find((item) => item.id === id)
    if (!record) return { ok: false, message: '记录不存在' }
    if (nextStatus === '已关闭' && record.items.some((item) => item.result === '异常')) {
      return { ok: false, message: '仍有异常项，不能关闭任务' }
    }
    if (nextStatus === '待复测' && !record.stopped && record.risk === '紧急') {
      return { ok: false, message: '紧急风险缺陷必须先执行停用' }
    }
    const now = new Date().toISOString()
    const nextRecord = clone(record)
    nextRecord.status = nextStatus
    nextRecord.version += 1
    nextRecord.updatedAt = now
    if (nextStatus === '已关闭') {
      nextRecord.closureBasis = { closedAt: now, version: nextRecord.version, items: clone(record.items) }
      nextRecord.reviewItems = []
    }
    const entry: AuditEntry = {
      id: `${id}-${genTxId()}`,
      recordId: id,
      action: `状态流转：${nextStatus}`,
      operator: operatorOf(currentRole.value, record),
      role: currentRole.value,
      detail,
      version: nextRecord.version,
      fields: ['流程状态'],
      createdAt: now
    }
    const result = applyCommit(nextRecord, entry)
    return result.ok ? { ok: true, message: `已流转至${nextStatus}` } : { ok: false, message: result.message }
  }

  function toggleStopped(id: string) {
    const record = records.value.find((item) => item.id === id)
    if (!record) return { ok: false, message: '记录不存在' }
    const now = new Date().toISOString()
    const nextRecord = clone(record)
    nextRecord.stopped = !record.stopped
    nextRecord.version += 1
    nextRecord.updatedAt = now
    const entry: AuditEntry = {
      id: `${id}-${genTxId()}`,
      recordId: id,
      action: nextRecord.stopped ? '设备停用隔离' : '设备恢复开放',
      operator: operatorOf(currentRole.value, record),
      role: currentRole.value,
      detail: nextRecord.stopped ? '设备转入停用隔离状态' : '设备解除停用，恢复开放',
      version: nextRecord.version,
      fields: ['设备状态'],
      createdAt: now
    }
    const result = applyCommit(nextRecord, entry)
    return result.ok ? { ok: true, message: nextRecord.stopped ? '已停用隔离' : '已恢复开放' } : { ok: false, message: result.message }
  }

  function resolveReview(id: string) {
    const record = records.value.find((item) => item.id === id)
    if (!record || !record.reviewItems?.length) return { ok: false, message: '没有待复核项' }
    const now = new Date().toISOString()
    const reviewed = record.reviewItems
    const nextRecord = clone(record)
    nextRecord.reviewItems = []
    nextRecord.version += 1
    nextRecord.updatedAt = now
    const entry: AuditEntry = {
      id: `${id}-${genTxId()}`,
      recordId: id,
      action: '完成复核',
      operator: operatorOf(currentRole.value, record),
      role: currentRole.value,
      detail: `复核关闭后变更的读数：${reviewed.join('、')}；关闭依据 V${record.closureBasis?.version ?? '-'} 保留不变`,
      version: nextRecord.version,
      fields: ['需复核项'],
      createdAt: now
    }
    const result = applyCommit(nextRecord, entry)
    return result.ok ? { ok: true, message: '复核完成，需复核项已清空' } : { ok: false, message: result.message }
  }

  function addRecord(draft: InspectionDraft) {
    const record = createOfflineInspection(draft)
    const entry: AuditEntry = {
      id: `${record.id}-${genTxId()}`,
      recordId: record.id,
      action: '创建检验记录',
      operator: draft.inspector,
      role: 'inspector',
      detail: '新建设备班次检验任务',
      version: record.version,
      createdAt: record.createdAt
    }
    applyCommit(record, entry)
    return record
  }

  function resetDemo() {
    const fresh = seedState()
    records.value = fresh.records
    audit.value = fresh.audit
    history.value = fresh.history
    committed.value = fresh.committed
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh))
  }

  // 兜底持久化：提交路径已保证原子性，这里只覆盖证据上传等零散变更
  watch([records, audit, history, committed], () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        records: records.value,
        audit: audit.value,
        history: history.value,
        committed: committed.value
      }))
    } catch {
      // 提交路径已处理失败回滚
    }
  }, { deep: true })

  return {
    records, audit, keyword, status, area, liveMessage, filtered, stats,
    currentRole, simulateFailure,
    addRecord, commitUpdate, transition, toggleStopped, resolveReview, resetDemo
  }
})
