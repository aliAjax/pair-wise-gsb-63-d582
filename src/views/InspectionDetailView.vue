<script setup lang="ts">
import { computed, h, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NDataTable, NInput, NSelect, NTag, useDialog, useMessage } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'
import { failureInjection } from '../services/commit'
import type { CheckResult, FieldConflict, InspectionRecord, InspectionStatus, RiskLevel } from '../types'

const route = useRoute()
const router = useRouter()
const store = useInspectionStore()
const message = useMessage()
const dialog = useDialog()

type Role = 'inspector' | 'supervisor'
const role = ref<Role>('inspector')
const roleMeta = {
  inspector: { label: '检验员', operator: '周宁' },
  supervisor: { label: '值班负责人', operator: '值班负责人·郑海' }
} as const

const record = computed(() => store.records.find((item) => item.id === route.params.id))

/** 进入编辑时锁定的版本（乐观锁基线） */
const baseVersion = ref(1)
const inspectorForm = reactive<Record<string, { reading: string; note: string }>>({})
/** 进入编辑时各检验项的原始值，只提交真正被本人改过的字段 */
const inspectorOriginal = reactive<Record<string, { reading: string; note: string }>>({})
const supervisorForm = reactive<{ risk: RiskLevel; assignedTo: string; dueDate: string; stopped: boolean }>({
  risk: '低', assignedTo: '', dueDate: '', stopped: false
})
const supervisorOriginal = ref<{ risk: RiskLevel; assignedTo: string; dueDate: string; stopped: boolean }>({
  risk: '低', assignedTo: '', dueDate: '', stopped: false
})
const conflicts = ref<FieldConflict[]>([])
const saving = ref(false)

function syncBase() {
  if (!record.value) return
  baseVersion.value = record.value.version
  conflicts.value = []
  for (const item of record.value.items) {
    inspectorForm[item.id] = { reading: item.reading, note: item.note }
    inspectorOriginal[item.id] = { reading: item.reading, note: item.note }
  }
  const supervisorSnapshot = {
    risk: record.value.risk,
    assignedTo: record.value.assignedTo,
    dueDate: record.value.dueDate,
    stopped: record.value.stopped
  }
  Object.assign(supervisorForm, supervisorSnapshot)
  supervisorOriginal.value = { ...supervisorSnapshot }
}

watch(record, syncBase, { immediate: true })

const stale = computed(() => !!record.value && record.value.version > baseVersion.value)
const items = computed(() => record.value?.items ?? [])
const transitions: InspectionStatus[] = ['待检验', '需整改', '整改中', '待复测', '已关闭', '停用']
const riskOptions = ['低', '中', '高', '紧急'].map((value) => ({ label: value, value: value as RiskLevel }))
const stopState = computed({
  get: () => supervisorForm.stopped ? '停用隔离' : '正常开放',
  set: (value: string) => { supervisorForm.stopped = value === '停用隔离' }
})

/** 只挑出相对进入编辑时真正改动过的检验项字段 */
function changedInspectorItems() {
  if (!record.value) return []
  return record.value.items.flatMap((item) => {
    const form = inspectorForm[item.id]
    const original = inspectorOriginal[item.id]
    const patch: { id: string; reading?: string; note?: string } = { id: item.id }
    if (form.reading !== original.reading) patch.reading = form.reading
    if (form.note !== original.note) patch.note = form.note
    return Object.keys(patch).length > 1 ? [patch] : []
  })
}

/** 负责人只提交自己相对进入编辑时改动过的字段，避免把旧值当新值覆盖 */
function changedSupervisorFields() {
  const payload: { risk?: RiskLevel; assignedTo?: string; dueDate?: string; stopped?: boolean } = {}
  const original = supervisorOriginal.value
  if (supervisorForm.risk !== original.risk) payload.risk = supervisorForm.risk
  if (supervisorForm.assignedTo !== original.assignedTo) payload.assignedTo = supervisorForm.assignedTo
  if (supervisorForm.dueDate !== original.dueDate) payload.dueDate = supervisorForm.dueDate
  if (supervisorForm.stopped !== original.stopped) payload.stopped = supervisorForm.stopped
  return payload
}

function save(activeRole: Role) {
  if (!record.value) return
  const itemPatches = activeRole === 'inspector' ? changedInspectorItems() : []
  const supervisorPatch = activeRole === 'supervisor' ? changedSupervisorFields() : {}
  if (activeRole === 'inspector' && itemPatches.length === 0) {
    message.info('没有需要保存的修改（仅你本人改过的实测值/备注会提交）')
    return
  }
  if (activeRole === 'supervisor' && Object.keys(supervisorPatch).length === 0) {
    message.info('没有需要保存的修改（仅你本人改过的处置字段会提交）')
    return
  }
  saving.value = true
  conflicts.value = []
  // 让异步通道有机会穿插，贴近真实并发；版本落后时引擎会做字段级三方合并
  setTimeout(() => {
    if (!record.value) {
      saving.value = false
      return
    }
    let result
    if (activeRole === 'inspector') {
      result = store.submitInspectorReadings(record.value.id, {
        operator: roleMeta.inspector.operator,
        baseVersion: baseVersion.value,
        items: itemPatches
      })
    } else {
      result = store.submitSupervisorDisposition(record.value.id, {
        operator: roleMeta.supervisor.operator,
        baseVersion: baseVersion.value,
        ...supervisorPatch
      })
    }
    saving.value = false

    if (result.ok) {
      message.success(result.message)
      if (result.version) {
        baseVersion.value = result.version
        // 保存生效后，把当前表单值作为新的编辑基线，避免重复提交同一内容
        for (const [id, value] of Object.entries(inspectorForm)) inspectorOriginal[id] = { ...value }
        supervisorOriginal.value = { ...supervisorForm }
      }
      conflicts.value = result.conflicts
      if (result.retestReset?.length) {
        message.warning(`未确认复测结论 ${result.retestReset.length} 项已按新读数失效重算`)
      }
      if (result.recheck?.length) {
        message.warning(`记录已关闭，原依据保留，${result.recheck.length} 项读数列入需复核`)
      }
    } else {
      message.error(result.message)
    }
  }, 120)
}

/** 演示并发：让对方先成功保存一笔，当前编辑仍停留在进入时的版本 */
function simulatePeerSave(activeRole: Role) {
  if (!record.value) return
  if (activeRole === 'inspector') {
    // 负责人先改风险与责任人
    const result = store.submitSupervisorDisposition(record.value.id, {
      operator: roleMeta.supervisor.operator,
      baseVersion: record.value.version,
      risk: record.value.risk === '紧急' ? '高' : '紧急',
      assignedTo: `${record.value.assignedTo}（负责人调整）`
    })
    if (result.ok) message.info(`值班负责人已先保存（V${result.version}），你的编辑仍基于 V${baseVersion.value}`)
  } else {
    // 检验员先改第一项实测值
    const first = record.value.items[0]
    const candidate = first.reading === '4.6 mm' ? '4.1 mm' : '4.6 mm'
    const result = store.submitInspectorReadings(record.value.id, {
      operator: roleMeta.inspector.operator,
      baseVersion: record.value.version,
      items: [{ id: first.id, reading: candidate }]
    })
    if (result.ok) message.info(`检验员已先保存（V${result.version}），你的编辑仍基于 V${baseVersion.value}`)
  }
}

/** 演示写入失败：下一次提交在审计写入时报错，整笔事务回滚 */
function armFailure() {
  failureInjection.failNextAuditWrite = true
  message.warning('已模拟审计通道故障：下一次保存将在写入审计时失败并整体回滚，可直接重试')
}

function reloadBase() {
  syncBase()
  message.success(`已载入最新版本 V${baseVersion.value}`)
}

function confirmRetest(itemId: string, pass: boolean) {
  if (!record.value) return
  const result = store.confirmRetestVerdict(record.value.id, itemId, roleMeta.inspector.operator, pass)
  result.ok ? message.success(result.message) : message.error(result.message)
}

function changeStatus(next: InspectionStatus) {
  if (!record.value) return
  dialog.warning({
    title: `确认流转至${next}`,
    content: '系统会校验异常项、停用状态和复测要求，状态、版本与审计在同一次提交内落库。',
    positiveText: '确认流转',
    negativeText: '取消',
    onPositiveClick: () => {
      const result = store.transition(record.value!.id, next, `由${record.value!.status}流转至${next}`, roleMeta[role.value].operator)
      result.ok ? message.success(result.message) : message.error(result.message)
      if (result.ok) baseVersion.value = record.value!.version
    }
  })
}

const resultTagType = (value: CheckResult) => value === '异常' ? 'error' : value === '正常' ? 'success' : 'default'
const retestTagType = (state: string) => state === '合格' ? 'success' : state === '不合格' ? 'error' : 'warning'

const inspectorColumns = [
  { title: '检验项', key: 'name', width: 130 },
  { title: '初检结果', key: 'result', width: 100, render: (row: any) => h(NTag, { type: resultTagType(row.result), size: 'small', bordered: false }, { default: () => row.result }) },
  { title: '实测值', key: 'reading', width: 180, render: (row: any) => h(NInput, { value: inspectorForm[row.id]?.reading, onUpdateValue: (value: string) => { inspectorForm[row.id].reading = value } }) },
  { title: '判定标准', key: 'limit', width: 130 },
  { title: '备注', key: 'note', render: (row: any) => h(NInput, { value: inspectorForm[row.id]?.note, onUpdateValue: (value: string) => { inspectorForm[row.id].note = value } }) }
]

function conflictFor(field: string, itemId?: string) {
  return conflicts.value.find((item) => item.field === field && (!itemId || item.itemId === itemId))
}

function exportRecord() {
  if (!record.value) return
  const blob = new Blob([JSON.stringify(record.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${record.value.id}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <section v-if="record" class="content detail-layout">
    <div class="detail-main">
      <div class="section-head">
        <div>
          <p>{{ record.deviceCode }} · {{ record.area }} · {{ record.shift }}</p>
          <h2>{{ record.deviceName }}</h2>
        </div>
        <div class="head-actions">
          <NTag :type="record.stopped ? 'error' : record.status === '已关闭' ? 'success' : 'warning'" :bordered="false">{{ record.stopped ? '设备已停用' : record.status }}</NTag>
          <NButton @click="exportRecord">导出记录</NButton>
        </div>
      </div>

      <div class="role-band">
        <div class="role-switch">
          <button :class="{ active: role === 'inspector' }" @click="role = 'inspector'">检验员视角（仅实测值/备注）</button>
          <button :class="{ active: role === 'supervisor' }" @click="role = 'supervisor'">值班负责人视角（风险/责任人/截止日）</button>
        </div>
        <div class="version-band" :class="{ stale }">
          <span>进入编辑基线 <strong>V{{ baseVersion }}</strong> · 库内当前 <strong>V{{ record.version }}</strong> · 当前身份：{{ roleMeta[role].label }} {{ roleMeta[role].operator }}</span>
          <NButton size="tiny" @click="reloadBase">重新载入最新版本</NButton>
          <NButton size="tiny" tertiary @click="simulatePeerSave(role)">模拟对方先保存</NButton>
          <NButton size="tiny" tertiary type="warning" @click="armFailure">模拟写入失败</NButton>
        </div>
      </div>

      <NAlert v-if="stale" type="warning" :bordered="false" class="stale-alert">
        记录在你编辑期间已被他人更新到 V{{ record.version }}。保存时将按字段三方合并：双方各改各的字段互不覆盖；同一字段都改了，保留你的填写并列出冲突。
      </NAlert>

      <NAlert v-if="conflicts.length" type="error" :bordered="false" class="stale-alert" title="并发字段冲突（已保留你的填写）">
        <ul class="conflict-list">
          <li v-for="conflict in conflicts" :key="`${conflict.field}-${conflict.itemId ?? 'scalar'}`">
            <strong>{{ conflict.itemName ? `${conflict.itemName}·${conflict.label}` : conflict.label }}</strong>：
            进入编辑时「{{ conflict.baseValue }}」→ 对方先改成「{{ conflict.currentValue }}」，已按你的提交保留为「{{ conflict.incomingValue }}」
          </li>
        </ul>
      </NAlert>

      <template v-if="role === 'inspector'">
        <h3>逐项检验结果 <small>检验员只能修改实测值与备注，初检结果不可在此改写</small></h3>
        <NDataTable :columns="inspectorColumns" :data="items" :bordered="false" size="small" :row-key="(row: any) => row.id" />

        <section v-if="record.retests.length" class="retest-panel">
          <h3>复测结论 <small>依据读数自动重算，确认后冻结</small></h3>
          <div v-for="verdict in record.retests" :key="verdict.itemId" class="retest-row">
            <div>
              <strong>{{ verdict.itemName }}</strong>
              <NTag size="small" :type="retestTagType(verdict.state)" :bordered="false">{{ verdict.state }}</NTag>
              <NTag size="small" :type="verdict.confirmed ? 'info' : 'warning'" :bordered="false">{{ verdict.confirmed ? `已确认·依据 V${verdict.basisVersion}` : `未确认·重算自 V${verdict.basisVersion}` }}</NTag>
            </div>
            <span>复测读数：{{ verdict.reading }}</span>
            <div v-if="!verdict.confirmed" class="retest-actions">
              <NButton size="tiny" type="primary" @click="confirmRetest(verdict.itemId, true)">复测合格确认</NButton>
              <NButton size="tiny" type="error" :disabled="stale" @click="confirmRetest(verdict.itemId, false)">复测不合格</NButton>
            </div>
            <small v-else>结论已冻结，读数再变不自动失效</small>
          </div>
        </section>

        <section v-if="record.status === '已关闭'" class="closure-panel">
          <h3>关闭依据与需复核项 <small>已关闭记录保留原依据，事后修正的读数只进入复核清单</small></h3>
          <NAlert type="info" :bordered="false">
            {{ record.closure?.basisSummary }}（关闭于 V{{ record.closure?.basisVersion }}）
          </NAlert>
          <table v-if="record.recheck.length" class="recheck-table">
            <thead><tr><th>检验项</th><th>关闭时读数</th><th>当前读数</th><th>发现版本</th></tr></thead>
            <tbody>
              <tr v-for="item in record.recheck" :key="item.itemId">
                <td>{{ item.itemName }}</td>
                <td>{{ item.closedReading }}</td>
                <td class="danger">{{ item.currentReading }}</td>
                <td>V{{ item.sinceVersion }} 起需复核</td>
              </tr>
            </tbody>
          </table>
        </section>

        <div class="save-bar">
          <NButton type="primary" :loading="saving" @click="save('inspector')">检验员保存实测值/备注</NButton>
        </div>
      </template>

      <template v-else>
        <h3>缺陷处置 <small>值班负责人只能调整风险、责任人、截止日期与停用隔离</small></h3>
        <div class="form-band">
          <label>整改责任人
            <NInput v-model:value="supervisorForm.assignedTo" />
            <i v-if="conflictFor('assignedTo')" class="field-conflict">冲突·已保留你的填写</i>
          </label>
          <label>截止日期
            <input v-model="supervisorForm.dueDate" class="native-date" type="date" />
            <i v-if="conflictFor('dueDate')" class="field-conflict">冲突·已保留你的填写</i>
          </label>
          <label>风险等级
            <NSelect v-model:value="supervisorForm.risk" :options="riskOptions" />
            <i v-if="conflictFor('risk')" class="field-conflict">冲突·已保留你的填写</i>
          </label>
          <label>设备状态
            <NSelect v-model:value="stopState" :options="['正常开放', '停用隔离'].map((value) => ({ label: value, value }))" />
            <i v-if="conflictFor('stopped')" class="field-conflict">冲突·已保留你的填写</i>
          </label>
        </div>
        <div class="save-bar">
          <NButton type="primary" :loading="saving" @click="save('supervisor')">负责人保存处置意见</NButton>
        </div>
      </template>

      <div class="evidence-panel">
        <div><strong>现场证据</strong><span>{{ record.evidenceCount }} 张照片 · 最近上传 09:31</span></div>
        <div class="evidence-list"><span>锁止间隙近景</span><span>设备铭牌</span><span>制动测试仪表</span></div>
      </div>
    </div>

    <aside class="detail-side">
      <div>
        <span class="side-label">当前流程</span>
        <strong>{{ record.status }}</strong>
        <small>版本 V{{ record.version }} · 更新于 {{ record.updatedAt.replace('T', ' ').slice(0, 16) }}</small>
      </div>
      <div class="flow-list">
        <button v-for="next in transitions" :key="next" :class="{ active: next === record.status }" @click="changeStatus(next)">
          <span>{{ next }}</span><small>{{ next === record.status ? '当前状态' : '执行流转' }}</small>
        </button>
      </div>
      <div class="rule-note">
        <strong>闭环校验</strong>
        <p>异常项存在或复测未全部合格时禁止关闭；紧急风险必须先停用设备。状态、版本与审计同一次提交。</p>
      </div>
      <NButton block @click="router.push('/audit')">查看完整审计</NButton>
    </aside>
  </section>
  <section v-else class="content empty-state">未找到检验记录</section>
</template>
