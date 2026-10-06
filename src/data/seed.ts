import type { AuditEntry, InspectionItem, InspectionRecord } from '../types'

const standardItems = (abnormal = false, readingOverrides: Record<string, string> = {}): InspectionItem[] => [
  { id: 'wear', name: '结构磨损', result: abnormal ? '异常' : '正常', reading: readingOverrides.wear ?? (abnormal ? '6.8 mm' : '2.1 mm'), limit: '≤ 5.0 mm', note: abnormal ? '主支撑连接处磨损超限' : '' },
  { id: 'noise', name: '运行异响', result: '正常', reading: readingOverrides.noise ?? '68 dB', limit: '≤ 75 dB', note: '' },
  { id: 'brake', name: '制动装置', result: '正常', reading: '制动距离 2.3 m', limit: '≤ 3.0 m', note: '' },
  { id: 'lock', name: '锁止机构', result: abnormal ? '异常' : '正常', reading: readingOverrides.lock ?? (abnormal ? '存在间隙' : '闭合可靠'), limit: '无可见间隙', note: abnormal ? '安全压杠锁止存在回弹' : '' },
  { id: 'safety', name: '安全装置', result: '正常', reading: '联锁有效', limit: '动作可靠', note: '' }
]

export const seedRecords: InspectionRecord[] = [
  {
    id: 'INS-240821-01', deviceCode: 'AM-014', deviceName: '高空飞翔', area: 'A区北侧', shift: '早班', inspector: '周宁',
    inspectedAt: '2026-09-28T08:20:00', status: '需整改', risk: '高', stopped: true, assignedTo: '维修一组', dueDate: '2026-09-29',
    items: standardItems(true), retests: [], closure: null, recheck: [], evidenceCount: 4, version: 3,
    createdAt: '2026-09-28T08:20:00', updatedAt: '2026-09-28T09:35:00'
  },
  {
    id: 'INS-240821-02', deviceCode: 'RC-007', deviceName: '家庭过山车', area: 'B区', shift: '早班', inspector: '李琪',
    inspectedAt: '2026-09-28T09:05:00', status: '整改中', risk: '中', stopped: false, assignedTo: '电气班组', dueDate: '2026-09-30',
    items: standardItems(true), retests: [], closure: null, recheck: [], evidenceCount: 2, version: 2,
    createdAt: '2026-09-28T09:05:00', updatedAt: '2026-09-28T11:10:00'
  },
  {
    // 待复测：磨损复测读数已回落（未确认），锁止仍不合格，二者均未确认
    id: 'INS-240821-03', deviceCode: 'CR-021', deviceName: '旋转木马', area: '亲子区', shift: '中班', inspector: '王璟',
    inspectedAt: '2026-09-27T15:40:00', status: '待复测', risk: '低', stopped: false, assignedTo: '检验二组', dueDate: '2026-09-29',
    items: standardItems(true, { wear: '4.6 mm' }),
    retests: [
      { itemId: 'wear', itemName: '结构磨损', state: '合格', reading: '4.6 mm', basisVersion: 4, confirmed: false, updatedAt: '2026-09-28T10:25:00' },
      { itemId: 'lock', itemName: '锁止机构', state: '不合格', reading: '存在间隙', basisVersion: 4, confirmed: false, updatedAt: '2026-09-28T10:25:00' }
    ],
    closure: null, recheck: [], evidenceCount: 3, version: 4,
    createdAt: '2026-09-27T15:40:00', updatedAt: '2026-09-28T10:25:00'
  },
  {
    // 已关闭：关闭依据冻结在 V5；之后异响读数被修正为超限，进入需复核但不动关闭状态
    id: 'INS-240821-04', deviceCode: 'WF-003', deviceName: '摩天轮', area: '湖景区', shift: '早班', inspector: '赵帆',
    inspectedAt: '2026-09-27T07:55:00', status: '已关闭', risk: '低', stopped: false, assignedTo: '维修二组', dueDate: '2026-09-28',
    items: standardItems(false, { noise: '77 dB' }),
    retests: [],
    closure: {
      state: '已关闭',
      basisVersion: 5,
      basisSummary: '关闭时全部 5 个检验项正常',
      itemReadings: { wear: '2.1 mm', noise: '68 dB', brake: '制动距离 2.3 m', lock: '闭合可靠', safety: '联锁有效' },
      confirmed: true,
      closedAt: '2026-09-28T16:20:00'
    },
    recheck: [
      { itemId: 'noise', itemName: '运行异响', closedReading: '68 dB', currentReading: '77 dB', sinceVersion: 6 }
    ],
    evidenceCount: 5, version: 6,
    createdAt: '2026-09-27T07:55:00', updatedAt: '2026-09-29T08:10:00'
  }
]

export const seedAudit: AuditEntry[] = seedRecords.flatMap((record) => [
  { id: `${record.id}-seed-create`, commitId: `CMT-SEED-${record.id}-create`, recordId: record.id, action: '创建检验记录', operator: record.inspector, detail: `${record.deviceName}完成班前检验`, createdAt: record.createdAt },
  { id: `${record.id}-seed-latest`, commitId: `CMT-SEED-${record.id}-latest`, recordId: record.id, action: record.status, operator: '系统流转', detail: `记录更新至版本 V${record.version}`, createdAt: record.updatedAt }
])
