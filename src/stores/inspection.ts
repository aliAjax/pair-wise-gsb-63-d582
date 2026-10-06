import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedRecords } from '../data/seed'
import { createOfflineInspection } from '../services/api'
import { commitInspectionChange, confirmRetest, transitionStatus, type CommitResult, type CommitState } from '../services/commit'
import type { AuditEntry, InspectionDraft, InspectionRecord, InspectionStatus, RiskLevel } from '../types'

const STORAGE_KEY = 'gsb63:inspection-platform'

interface PersistedState {
  records: InspectionRecord[]
  audit: AuditEntry[]
}

/** 兼容旧版本本地快照：补齐复测、关闭结论与提交 ID */
function migrate(raw: PersistedState): PersistedState {
  return {
    records: raw.records.map((record) => ({
      ...record,
      retests: record.retests ?? [],
      closure: record.closure ?? null,
      recheck: record.recheck ?? [],
      lastCommitId: record.lastCommitId
    })),
    audit: raw.audit.map((entry) => ({ ...entry, commitId: entry.commitId ?? `CMT-LEGACY-${entry.id}` }))
  }
}

function readPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? migrate(JSON.parse(raw)) : { records: structuredClone(seedRecords), audit: structuredClone(seedAudit) }
  } catch {
    return { records: structuredClone(seedRecords), audit: structuredClone(seedAudit) }
  }
}

export interface InspectorPayload {
  operator: string
  baseVersion: number
  items: Array<{ id: string; reading?: string; note?: string }>
}

export interface SupervisorPayload {
  operator: string
  baseVersion: number
  risk?: RiskLevel
  assignedTo?: string
  dueDate?: string
  stopped?: boolean
}

export const useInspectionStore = defineStore('inspection', () => {
  const initial = readPersisted()
  const records = ref<InspectionRecord[]>(initial.records)
  const audit = ref<AuditEntry[]>(initial.audit)
  const keyword = ref('')
  const status = ref<InspectionStatus | '全部'>('全部')
  const area = ref('全部')
  const liveMessage = ref('本地实时通道已就绪')

  /** 引擎直接在同一状态对象上落库，保证记录、版本、审计同一次提交 */
  const commitState = computed<CommitState>(() => ({ records: records.value, audit: audit.value }))

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

  function addRecord(draft: InspectionDraft) {
    const record = createOfflineInspection(draft)
    records.value.unshift(record)
    const time = new Date().toISOString()
    audit.value.unshift({
      id: `${record.id}-CMT-create`,
      commitId: `CMT-${record.id}-create`,
      recordId: record.id,
      action: '创建检验记录',
      operator: draft.inspector,
      detail: '新建设备班次检验任务（V1）',
      createdAt: time
    })
    record.lastCommitId = `CMT-${record.id}-create`
    return record
  }

  /** 检验员提交：只能改实测值和备注，按进入编辑版本乐观检查 */
  function submitInspectorReadings(id: string, payload: InspectorPayload): CommitResult {
    return commitInspectionChange(commitState.value, id, {
      role: 'inspector',
      operator: payload.operator,
      baseVersion: payload.baseVersion,
      items: payload.items
    })
  }

  /** 值班负责人提交：只能改风险、责任人、截止日期和停用隔离 */
  function submitSupervisorDisposition(id: string, payload: SupervisorPayload): CommitResult {
    return commitInspectionChange(commitState.value, id, {
      role: 'supervisor',
      operator: payload.operator,
      baseVersion: payload.baseVersion,
      risk: payload.risk,
      assignedTo: payload.assignedTo,
      dueDate: payload.dueDate,
      stopped: payload.stopped
    })
  }

  function confirmRetestVerdict(id: string, itemId: string, operator: string, pass: boolean): CommitResult {
    return confirmRetest(commitState.value, id, itemId, operator, pass)
  }

  function transition(id: string, next: InspectionStatus, detail?: string, operator = '当前用户') {
    return transitionStatus(commitState.value, id, next, operator, detail)
  }

  function resetDemo() {
    records.value = structuredClone(seedRecords)
    audit.value = structuredClone(seedAudit)
  }

  watch([records, audit], () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ records: records.value, audit: audit.value }))
  }, { deep: true })

  return {
    records,
    audit,
    keyword,
    status,
    area,
    liveMessage,
    filtered,
    stats,
    addRecord,
    submitInspectorReadings,
    submitSupervisorDisposition,
    confirmRetestVerdict,
    transition,
    resetDemo
  }
})
