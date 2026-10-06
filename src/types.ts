export type InspectionStatus = '待检验' | '需整改' | '整改中' | '待复测' | '已关闭' | '停用'
export type RiskLevel = '低' | '中' | '高' | '紧急'
export type CheckResult = '正常' | '异常' | '不适用'
export type EditorRole = 'inspector' | 'supervisor'

export interface InspectionItem {
  id: string
  name: string
  result: CheckResult
  reading: string
  limit: string
  note: string
}

export interface ClosureBasis {
  closedAt: string
  version: number
  items: InspectionItem[]
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
  evidenceCount: number
  version: number
  closureBasis?: ClosureBasis
  reviewItems?: string[]
  createdAt: string
  updatedAt: string
}

export interface AuditEntry {
  id: string
  recordId: string
  action: string
  operator: string
  role?: EditorRole
  detail: string
  version?: number
  txId?: string
  fields?: string[]
  createdAt: string
}

export interface FieldChange {
  field: string
  label: string
  before: string
  after: string
}

export interface InspectionItemPatch {
  id: string
  reading?: string
  note?: string
}

export interface CommitPatch {
  items?: InspectionItemPatch[]
  risk?: RiskLevel
  assignedTo?: string
  dueDate?: string
}

export interface CommitResult {
  ok: boolean
  message: string
  version?: number
  conflicts?: FieldChange[]
  invalidated?: string[]
  deduplicated?: boolean
  retryable?: boolean
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
