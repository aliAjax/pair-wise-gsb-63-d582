export type InspectionStatus = '待检验' | '需整改' | '整改中' | '待复测' | '已关闭' | '停用'
export type RiskLevel = '低' | '中' | '高' | '紧急'
export type CheckResult = '正常' | '异常' | '不适用'

export interface InspectionItem {
  id: string
  name: string
  result: CheckResult
  reading: string
  limit: string
  note: string
}

/** 复测结论：依据某个读数版本生成，读数变化后未确认的结论会失效重算 */
export interface RetestVerdict {
  itemId: string
  itemName: string
  state: '待复测' | '合格' | '不合格'
  reading: string
  /** 结论所依据的记录版本；读数被改写后需要重新确认 */
  basisVersion: number
  /** 未确认：系统按当前读数重算；检验/负责人确认后冻结，不随读数自动变化 */
  confirmed: boolean
  updatedAt: string
}

/** 关闭结论：已关闭记录冻结原依据，读数事后被修正时进入需复核列表 */
export interface ClosureVerdict {
  state: '待确认关闭' | '已关闭'
  basisVersion: number
  basisSummary: string
  /** 关闭时点各检验项读数，事后修正读数时据此对比列出需复核项 */
  itemReadings: Record<string, string>
  confirmed: boolean
  closedAt: string
}

export interface RecheckItem {
  itemId: string
  itemName: string
  closedReading: string
  currentReading: string
  sinceVersion: number
}

export interface InspectionRecord {
  id: string
  deviceCode: string
  deviceName: string
  area: string
  shift: string
  inspector: string
  inspectedAt: string
  status: InspectionStatus
  risk: RiskLevel
  stopped: boolean
  assignedTo: string
  dueDate: string
  items: InspectionItem[]
  retests: RetestVerdict[]
  closure: ClosureVerdict | null
  recheck: RecheckItem[]
  evidenceCount: number
  version: number
  /** 最近一次成功提交的 ID，重试时据此保证审计只生成一次 */
  lastCommitId?: string
  /** 历史完整版本，供乐观锁三方合并按“进入编辑版本”取基线 */
  snapshots?: InspectionRecord[]
  createdAt: string
  updatedAt: string
}

export interface AuditEntry {
  id: string
  /** 同一次提交（检验项 + 版本 + 审计）共享的提交 ID，重试复用且只生成一次审计 */
  commitId: string
  recordId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

export interface InspectionDraft {
  deviceCode: string
  deviceName: string
  area: string
  shift: string
  inspector: string
  risk: RiskLevel
  assignedTo: string
  dueDate: string
}

/** 提交角色：检验员只能动实测值/备注，值班负责人只能动风险/责任人/截止日期/停用 */
export type EditRole = 'inspector' | 'supervisor'

/** 三方合并后的字段冲突（后到者与先到者改了同一字段） */
export interface FieldConflict {
  kind: 'scalar' | 'item'
  field: string
  label: string
  itemId?: string
  itemName?: string
  baseValue: string
  incomingValue: string
  currentValue: string
  /** 保留策略：后到者保留自己的填写内容 */
  resolution: '保留本次提交'
}
