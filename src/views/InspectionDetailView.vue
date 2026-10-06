<script setup lang="ts">
import { computed, h, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDataTable, NInput, NSelect, NTag, useDialog, useMessage } from 'naive-ui'
import { genTxId, useInspectionStore } from '../stores/inspection'
import type { CommitPatch, InspectionRecord, InspectionStatus, RiskLevel } from '../types'

const route = useRoute()
const router = useRouter()
const store = useInspectionStore()
const message = useMessage()
const dialog = useDialog()

const record = computed(() => store.records.find((item) => item.id === route.params.id))
const form = reactive<Partial<InspectionRecord>>({})
const baseVersion = ref(0)
let pendingTxId: string | null = null

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const isInspector = computed(() => store.currentRole === 'inspector')
const externalUpdate = computed(() => Boolean(record.value && record.value.version !== baseVersion.value))
const items = computed(() => form.items ?? [])
const transitions: InspectionStatus[] = ['待检验', '需整改', '整改中', '待复测', '已关闭', '停用']

function resetForm() {
  if (!record.value) return
  Object.keys(form).forEach((key) => delete (form as Record<string, unknown>)[key])
  Object.assign(form, clone(record.value))
  baseVersion.value = record.value.version
  pendingTxId = null
}

watch(() => route.params.id, resetForm, { immediate: true })

function save() {
  const current = record.value
  if (!current) return
  const editingBase = baseVersion.value
  // 写入失败的重试沿用同一事务号，保证不重复生成审计
  const txId = pendingTxId ?? genTxId()
  const patch: CommitPatch = isInspector.value
    ? { items: (form.items ?? []).map((item) => ({ id: item.id, reading: item.reading, note: item.note })) }
    : { risk: form.risk, assignedTo: form.assignedTo, dueDate: form.dueDate }
  const result = store.commitUpdate(current.id, store.currentRole, patch, editingBase, txId)
  if (!result.ok) {
    pendingTxId = txId
    message.error(`${result.message}，可再次点击保存重试`)
    return
  }
  resetForm()
  if (result.deduplicated) {
    message.info(result.message)
    return
  }
  result.invalidated?.forEach((text) => message.warning(text, { duration: 6000 }))
  if (result.conflicts?.length) {
    const conflicts = result.conflicts
    dialog.warning({
      title: '检测到并发修改，已保留你的填写并合并',
      content: () => h('div', null, [
        h('p', null, `你进入编辑时记录为 V${editingBase}，另一方已先保存。以下字段由对方修改，未覆盖你的填写：`),
        h('ul', null, conflicts.map((item) => h('li', { key: item.field }, `${item.label}：${item.before} → ${item.after}`)))
      ]),
      positiveText: '知道了'
    })
    return
  }
  result.version === editingBase ? message.info(result.message) : message.success(result.message)
}

function changeStatus(next: InspectionStatus) {
  if (!record.value) return
  dialog.warning({
    title: `确认流转至${next}`,
    content: '系统会校验异常项、停用状态和复测要求，并写入操作审计。',
    positiveText: '确认流转',
    negativeText: '取消',
    onPositiveClick: () => {
      const result = store.transition(record.value!.id, next, `由${record.value!.status}流转至${next}`)
      if (result.ok) {
        resetForm()
        message.success(result.message)
      } else {
        message.error(result.message)
      }
    }
  })
}

function toggleStopped() {
  if (!record.value) return
  const result = store.toggleStopped(record.value.id)
  if (result.ok) {
    resetForm()
    message.success(result.message)
  } else {
    message.error(result.message)
  }
}

function resolveReview() {
  if (!record.value) return
  const result = store.resolveReview(record.value.id)
  if (result.ok) {
    resetForm()
    message.success(result.message)
  } else {
    message.error(result.message)
  }
}

// 演示：模拟另一方在你编辑期间先保存，触发版本冲突检查
function simulatePeerSave() {
  const current = record.value
  if (!current) return
  if (isInspector.value) {
    const risks: RiskLevel[] = ['低', '中', '高', '紧急']
    const nextRisk = risks[(risks.indexOf(current.risk) + 1) % risks.length]
    store.commitUpdate(current.id, 'supervisor', { risk: nextRisk }, current.version, genTxId(), { action: '负责人调整风险等级' })
    message.info(`已模拟值班负责人在你编辑期间保存风险等级（${current.risk} → ${nextRisk}）`)
  } else {
    const target = current.items.find((item) => item.result === '异常') ?? current.items[0]
    const bumped = target.reading.replace(/-?\d+(?:\.\d+)?/, (num) => (Number(num) + 0.4).toFixed(1))
    const reading = bumped === target.reading ? `${target.reading}（复录）` : bumped
    store.commitUpdate(current.id, 'inspector', { items: [{ id: target.id, reading }] }, current.version, genTxId(), { action: '检验员复录实测值' })
    message.info(`已模拟检验员在你编辑期间复录「${target.name}」实测值`)
  }
}

function readingOf(list: InspectionRecord['items'] | undefined, name: string) {
  return list?.find((item) => item.name === name)?.reading ?? '-'
}

function fmtTime(iso?: string) {
  return iso ? iso.replace('T', ' ').slice(0, 16) : '-'
}

const columns = computed(() => [
  { title: '检验项', key: 'name', width: 130 },
  {
    title: '结果',
    key: 'result',
    width: 100,
    render: (row: any) => h(NTag, { size: 'small', bordered: false, type: row.result === '异常' ? 'error' : row.result === '正常' ? 'success' : 'default' }, { default: () => row.result })
  },
  {
    title: '实测值',
    key: 'reading',
    width: 170,
    render: (row: any) => h(NInput, { value: row.reading, disabled: !isInspector.value, placeholder: isInspector.value ? '' : '仅检验员可改', onUpdateValue: (value: string) => { row.reading = value } })
  },
  { title: '判定标准', key: 'limit', width: 150 },
  {
    title: '备注',
    key: 'note',
    render: (row: any) => h(NInput, { value: row.note, disabled: !isInspector.value, placeholder: isInspector.value ? '' : '仅检验员可改', onUpdateValue: (value: string) => { row.note = value } })
  }
])

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
          <NTag v-if="record.reviewItems?.length" type="warning" :bordered="false">需复核 {{ record.reviewItems.length }} 项</NTag>
          <NButton @click="exportRecord">导出记录</NButton>
          <NButton type="primary" @click="save">保存新版本</NButton>
        </div>
      </div>

      <div class="role-bar">
        <span>当前身份</span>
        <button :class="{ active: isInspector }" @click="store.currentRole = 'inspector'">检验员 · {{ record.inspector }}</button>
        <button :class="{ active: !isInspector }" @click="store.currentRole = 'supervisor'">值班负责人 · 陈岚</button>
        <small>{{ isInspector ? '仅可修改实测值与备注' : '仅可修改风险等级、整改责任人与截止日期' }}</small>
      </div>

      <div v-if="externalUpdate" class="merge-banner">
        记录已被他人更新至 V{{ record.version }}（你的编辑基准为 V{{ baseVersion }}），保存时将保留你的填写并列出冲突字段。
      </div>

      <div class="form-band">
        <label>整改责任人 <NInput v-model:value="form.assignedTo" :disabled="isInspector" /></label>
        <label>截止日期 <input v-model="form.dueDate" class="native-date" type="date" :disabled="isInspector" /></label>
        <label>风险等级 <NSelect v-model:value="form.risk" :disabled="isInspector" :options="['低', '中', '高', '紧急'].map((value) => ({ label: value, value }))" /></label>
        <label>设备状态
          <div class="stopped-cell">
            <NTag size="small" :type="record.stopped ? 'error' : 'success'" :bordered="false">{{ record.stopped ? '停用隔离' : '正常开放' }}</NTag>
            <button class="link-btn" @click="toggleStopped">{{ record.stopped ? '恢复开放' : '停用隔离' }}</button>
          </div>
        </label>
      </div>

      <h3>逐项检验结果</h3>
      <p class="table-hint">检验员录入实测值后，结果按判定标准自动核算；复测依赖的读数一变，未确认的复测与关闭结论将失效重算。</p>
      <NDataTable :columns="columns" :data="items" :bordered="false" size="small" />

      <div v-if="record.status === '已关闭' && record.reviewItems?.length" class="review-panel">
        <strong>需复核项（关闭后读数变更）</strong>
        <p>关闭依据 V{{ record.closureBasis?.version ?? '-' }} · {{ fmtTime(record.closureBasis?.closedAt) }} 保留不变，以下检验项读数在关闭后被变更：</p>
        <ul>
          <li v-for="name in record.reviewItems" :key="name">
            {{ name }}：关闭时 {{ readingOf(record.closureBasis?.items, name) }} → 当前 {{ readingOf(record.items, name) }}
          </li>
        </ul>
        <NButton size="small" @click="resolveReview">完成复核</NButton>
      </div>

      <div class="evidence-panel">
        <div><strong>现场证据</strong><span>{{ record.evidenceCount }} 张照片 · 最近上传 09:31</span></div>
        <div class="evidence-list"><span>锁止间隙近景</span><span>设备铭牌</span><span>制动测试仪表</span><button @click="record.evidenceCount += 1; message.success('已模拟上传现场照片')">上传照片</button></div>
      </div>
    </div>

    <aside class="detail-side">
      <div>
        <span class="side-label">当前流程</span>
        <strong>{{ record.status }}</strong>
        <small>版本 V{{ record.version }} · 编辑基准 V{{ baseVersion }} · 更新于 {{ fmtTime(record.updatedAt) }}</small>
        <small v-if="record.closureBasis">关闭依据 V{{ record.closureBasis.version }} · {{ fmtTime(record.closureBasis.closedAt) }}</small>
      </div>
      <div class="flow-list">
        <button v-for="status in transitions" :key="status" :class="{ active: status === record.status }" @click="changeStatus(status)">
          <span>{{ status }}</span><small>{{ status === record.status ? '当前状态' : '执行流转' }}</small>
        </button>
      </div>
      <div class="rule-note">
        <strong>闭环校验</strong>
        <p>检验员仅改实测值/备注，负责人仅改风险/责任人/截止日期；保存按进入编辑时的版本检查，后到者保留填写并列出冲突字段；异常项存在时禁止关闭，紧急风险必须先停用。</p>
      </div>
      <div class="demo-box">
        <strong>并发与故障演示</strong>
        <button @click="simulatePeerSave">模拟另一方先保存</button>
        <label><input v-model="store.simulateFailure" type="checkbox" /> 下次写入失败（验证恢复与重试）</label>
      </div>
      <NButton block @click="router.push('/audit')">查看完整审计</NButton>
    </aside>
  </section>
  <section v-else class="content empty-state">未找到检验记录</section>
</template>
