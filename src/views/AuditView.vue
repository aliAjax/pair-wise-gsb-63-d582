<script setup lang="ts">
import { computed, ref } from 'vue'
import { NInput, NTag } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'

const store = useInspectionStore()
const keyword = ref('')
const entries = computed(() => store.audit.filter((item) => !keyword.value || `${item.recordId} ${item.action} ${item.operator} ${item.detail} ${item.txId ?? ''}`.includes(keyword.value)))
const roleLabel = (role?: string) => role === 'inspector' ? '检验员' : role === 'supervisor' ? '值班负责人' : ''
</script>

<template>
  <section class="content audit-layout">
    <div class="audit-head">
      <div><h2>操作审计与版本追溯</h2><p>每次提交与检验项、记录版本同事务落库，记录创建、检验修改、状态流转和冲突合并的完整时间线。</p></div>
      <NInput v-model:value="keyword" clearable placeholder="按编号、操作人、动作搜索" style="max-width: 330px" />
    </div>
    <div class="timeline">
      <article v-for="entry in entries" :key="entry.id">
        <div class="time">{{ entry.createdAt.replace('T', ' ').slice(0, 16) }}</div>
        <i />
        <div class="audit-card">
          <header>
            <strong>{{ entry.action }}</strong>
            <div class="audit-tags">
              <NTag v-if="entry.version" size="small" type="info" :bordered="false">V{{ entry.version }}</NTag>
              <NTag size="small" :bordered="false">{{ entry.recordId }}</NTag>
            </div>
          </header>
          <p>{{ entry.detail }}</p>
          <small>
            操作人：{{ entry.operator }}<template v-if="entry.role">（{{ roleLabel(entry.role) }}）</template>
            <template v-if="entry.fields?.length"> · 字段：{{ entry.fields.join('、') }}</template>
            <template v-if="entry.txId"> · 事务 #{{ entry.txId.slice(-6) }}</template>
          </small>
        </div>
      </article>
    </div>
  </section>
</template>
