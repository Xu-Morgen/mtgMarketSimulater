"use client";

import type { AdminCampaignDto, AdminCampaignPreviewDto, CampaignScopeType } from "@mtg-market/contracts";
import { useState } from "react";
import {
  useCreateCampaignDraftMutation,
  useEndCampaignMutation,
  usePauseCampaignMutation,
  usePreviewCampaignMutation,
  usePublishCampaignMutation,
  useScheduleCampaignMutation,
  useAdminCampaignsQuery
} from "../../api/admin-api";
import { ApiClientError } from "../../api/client";
import { ConfirmDialog, EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { useToast } from "../../providers/toast-provider";
import { bpsToPercent, campaignStatusLabel, formatDateTime } from "./admin-format";
import styles from "./admin-shared.module.css";

const emptyDraft = {
  code: "", name: "", description: "", scopeType: "global" as CampaignScopeType, scopeId: "",
  factorBps: 10000, displayText: "", startsAt: "", endsAt: "", reason: ""
};

type Flow = "publish" | "schedule" | "pause" | "end";

/** I30F 活动管理：草稿 → 服务端预览 → 发布/定时发布 → 暂停/结束。版本、任务状态与审计均来自服务端。 */
export function AdminEventsPage() {
  const campaigns = useAdminCampaignsQuery(50, 0);
  // 活动生命周期对话框在表格之外渲染，避免把 dialog 容器塞进 <tbody> 造成无效嵌套。
  const [active, setActive] = useState<{ campaign: AdminCampaignDto; flow: Flow; preview: AdminCampaignPreviewDto | null } | null>(null);
  if (campaigns.isPending) return <PageSkeleton label="正在加载活动" />;
  if (campaigns.isError) return <main className="page"><ErrorState title={campaigns.error instanceof ApiClientError && campaigns.error.code === "AUTHORIZATION_DENIED" ? "无权管理活动" : "活动加载失败"} onRetry={() => void campaigns.refetch()} /></main>;
  if (!campaigns.data) return <PageSkeleton label="正在确认活动访问权限" />;
  const items = campaigns.data.data.items;
  return <main className={`page ${styles.page}`}>
    <h1>活动管理</h1>
    <p className={styles.intro}>活动发布绑定预览版本、实体版本与幂等键；已发布版本不可原地覆盖，成功后投递可重放的 market.reprice，且不会改写外部价格快照。</p>
    <CreateDraftSection />
    <section className={styles.card}>
      <h2>活动列表</h2>
      {items.length === 0 ? <EmptyState title="暂无活动">还没有创建任何活动。</EmptyState> : <div className={styles.tableWrap}><table><thead><tr><th>代码</th><th>名称</th><th>状态</th><th>范围</th><th>因子</th><th>区间（utc）</th><th>版本</th><th>操作</th></tr></thead><tbody>
        {items.map((campaign) => <CampaignRow key={campaign.id} campaign={campaign} onOpen={(flow, preview) => setActive({ campaign, flow, preview })} />)}
      </tbody></table></div>}
    </section>
    {active ? <CampaignFlowDialog state={active} onClose={() => setActive(null)} /> : null}
  </main>;
}

function CreateDraftSection() {
  const create = useCreateCampaignDraftMutation();
  const { showToast } = useToast();
  const [form, setForm] = useState(emptyDraft);
  const [confirm, setConfirm] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const factorPercent = bpsToPercent(form.factorBps);
  const valid = Boolean(form.code.trim() && form.name.trim() && form.displayText.trim() && form.startsAt && form.endsAt && new Date(form.endsAt).getTime() > new Date(form.startsAt).getTime()) && (form.scopeType === "global" || Boolean(form.scopeId.trim()));
  const submit = () => create.mutate({
    code: form.code.trim(), name: form.name.trim(), description: form.description.trim() || null,
    campaignType: "market_factor", scopeType: form.scopeType, scopeId: form.scopeType === "global" ? null : form.scopeId.trim(),
    factorBps: form.factorBps, displayText: form.displayText.trim(),
    // datetime-local 以本地时区输入，提交标准化为 UTC ISO 8601。
    startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString(),
    reason: form.reason.trim() || null
  }, {
    onSuccess: () => { showToast("活动草稿已保存，请预览后再发布。"); setForm(emptyDraft); },
    onError: (error) => showToast(error instanceof Error ? error.message : "草稿保存失败", "error")
  });
  return <section className={styles.card}>
    <h2>新建活动草稿</h2>
    <p className={styles.intro}>填表只创建草稿；正式发布必须先调用服务端预览，确认范围、参数版本、冲突与预计任务后再提交。</p>
    <div className={styles.filterGrid}>
      <label>活动代码<input aria-label="活动代码" value={form.code} onChange={(event) => set("code", event.target.value)} placeholder="唯一代码，例如 summer-2026" /></label>
      <label>活动名称<input aria-label="活动名称" value={form.name} onChange={(event) => set("name", event.target.value)} /></label>
      <label>展示文案<input aria-label="展示文案" value={form.displayText} onChange={(event) => set("displayText", event.target.value)} /></label>
      <label>作用范围<select aria-label="作用范围" value={form.scopeType} onChange={(event) => set("scopeType", event.target.value as CampaignScopeType)}>
        <option value="global">全服</option><option value="set">指定系列</option><option value="sku">指定 SKU</option>
      </select></label>
      {form.scopeType !== "global" ? <label>{form.scopeType === "set" ? "系列代码" : "SKU ID"}<input aria-label="作用范围标识" value={form.scopeId} onChange={(event) => set("scopeId", event.target.value)} /></label> : null}
      <label>市场因子（基准点）<input type="number" min={5000} max={20000} step={100} aria-label="市场因子基准点" value={form.factorBps} onChange={(event) => set("factorBps", Number.parseInt(event.target.value, 10))} /></label>
      <span className={styles.intro}>约等于 {factorPercent}；范围 5000–20000 基准点。</span>
      <label>开始时间（本地）<input type="datetime-local" aria-label="开始时间" value={form.startsAt} onChange={(event) => set("startsAt", event.target.value)} /></label>
      <label>结束时间（本地）<input type="datetime-local" aria-label="结束时间" value={form.endsAt} onChange={(event) => set("endsAt", event.target.value)} /></label>
      <label>原因（可选）<input aria-label="原因" value={form.reason} onChange={(event) => set("reason", event.target.value)} /></label>
      <label>备注（可选）<input aria-label="备注" value={form.description} onChange={(event) => set("description", event.target.value)} /></label>
    </div>
    <div className={styles.actions}><button className="button" type="button" disabled={!valid || create.isPending} onClick={() => setConfirm(true)}>{create.isPending ? "正在保存…" : "保存草稿"}</button></div>
    <ConfirmDialog open={confirm} title="确认保存活动草稿？" description={`将以代码 ${form.code.trim() || "（未填）"} 创建草稿；正式发布须在列表中预览后再提交。`} onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); submit(); }} />
  </section>;
}

function CampaignRow({ campaign, onOpen }: { campaign: AdminCampaignDto; onOpen: (flow: Flow, preview: AdminCampaignPreviewDto | null) => void }) {
  const previewMutation = usePreviewCampaignMutation();
  const { showToast } = useToast();
  const runPreview = () => previewMutation.mutate(campaign.id, {
    onSuccess: (response) => { onOpen("publish", response.data); showToast("预览完成，请确认范围、版本与冲突后再发布。"); },
    onError: (error) => showToast(error instanceof Error ? error.message : "预览失败", "error")
  });
  return <tr>
    <td className={styles.mono}>{campaign.code}</td>
    <td>{campaign.name}</td>
    <td><span className={styles[campaign.status]}>{campaignStatusLabel(campaign.status)}</span></td>
    <td>{scopeLabel(campaign.scopeType, campaign.scopeId)}</td>
    <td>{bpsToPercent(campaign.factorBps)}</td>
    <td className={styles.mono}>{formatDateTime(campaign.startsAt)} → {formatDateTime(campaign.endsAt)}</td>
    <td>v{campaign.version}</td>
    <td>
      <div className={styles.actions}>
        {campaign.status === "draft" || campaign.status === "previewing" ? <button className="button secondary" type="button" disabled={previewMutation.isPending} onClick={runPreview}>{previewMutation.isPending ? "预览中…" : "预览"}</button> : null}
        {campaign.status === "published" ? <button className="button secondary" type="button" onClick={() => onOpen("pause", null)}>暂停</button> : null}
        {(campaign.status === "published" || campaign.status === "paused") ? <button className="button secondary" type="button" onClick={() => onOpen("end", null)}>结束</button> : null}
      </div>
    </td>
  </tr>;
}

function CampaignFlowDialog({ state, onClose }: { state: { campaign: AdminCampaignDto; flow: Flow; preview: AdminCampaignPreviewDto | null }; onClose: () => void }) {
  const { campaign, flow, preview } = state;
  const [currentFlow, setCurrentFlow] = useState<Flow>(flow);
  const publishMutation = usePublishCampaignMutation();
  const scheduleMutation = useScheduleCampaignMutation();
  const pauseMutation = usePauseCampaignMutation();
  const endMutation = useEndCampaignMutation();
  const { showToast } = useToast();
  const anyPending = publishMutation.isPending || scheduleMutation.isPending || pauseMutation.isPending || endMutation.isPending;
  const previewVersion = preview?.previewVersion;
  const submit = () => {
    if ((currentFlow === "publish" || currentFlow === "schedule") && previewVersion === undefined) { onClose(); return; }
    if (currentFlow === "publish" && previewVersion !== undefined) publishMutation.mutate({ id: campaign.id, previewVersion }, { onSuccess: () => { showToast("活动已发布，市场重价任务已投递。"); onClose(); }, onError: (error) => showToast(error instanceof Error ? error.message : "发布失败", "error") });
    if (currentFlow === "schedule" && previewVersion !== undefined) scheduleMutation.mutate({ id: campaign.id, previewVersion }, { onSuccess: () => { showToast("定时发布已登记，到点由后台投递重价任务。"); onClose(); }, onError: (error) => showToast(error instanceof Error ? error.message : "定时发布失败", "error") });
    if (currentFlow === "pause") pauseMutation.mutate(campaign.id, { onSuccess: () => { showToast("活动已暂停。"); onClose(); }, onError: (error) => showToast(error instanceof Error ? error.message : "暂停失败", "error") });
    if (currentFlow === "end") endMutation.mutate(campaign.id, { onSuccess: () => { showToast("活动已结束。"); onClose(); }, onError: (error) => showToast(error instanceof Error ? error.message : "结束失败", "error") });
  };
  const title = currentFlow === "publish" ? "确认发布活动？" : currentFlow === "schedule" ? "确认定时发布？" : currentFlow === "pause" ? "确认暂停活动？" : "确认结束活动？";
  const isPublishFlow = currentFlow === "publish" || currentFlow === "schedule";
  const description = preview && isPublishFlow
    ? `将以预览版本 ${preview.previewVersion} 发布；${preview.conflicts.length > 0 ? `存在 ${preview.conflicts.length} 个作用域/区间冲突，服务端会拒绝。` : "无冲突。"}预计触发 market.reprice 任务。`
    : currentFlow === "pause" ? "已发布活动可暂停；暂停后可再发布或结束。" : currentFlow === "end" ? "结束后活动不可再发布。" : "";
  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="campaign-flow-title">
      <h2 id="campaign-flow-title">{title}</h2>
      {preview && isPublishFlow ? <section className={styles.notice} aria-label="服务端预览结果">
        <h3>服务端预览（previewVersion {preview.previewVersion}）</h3>
        <dl className={styles.details}>
          <div><dt>作用域</dt><dd>{scopeLabel(preview.campaign.scopeType, preview.campaign.scopeId)}</dd></div>
          <div><dt>因子</dt><dd>{bpsToPercent(preview.campaign.factorBps)}（{preview.factorBpsInRange ? "范围内" : "超出范围"}）</dd></div>
          <div><dt>预计重价任务</dt><dd className={styles.mono}>{preview.scheduledReprice ? `${preview.scheduledReprice.triggerKey} @ ${formatDateTime(preview.scheduledReprice.runAfter)}` : "—"}</dd></div>
          <div><dt>冲突</dt><dd>{preview.conflicts.length === 0 ? "无" : preview.conflicts.map((conflict) => conflict.code).join("、")}</dd></div>
        </dl>
        <p className={styles.intro}>如需改为到点定时发布，可切换为定时发布；二者均使用独立幂等意图。</p>
        <div className={styles.actions}>
          <button className={`button ${currentFlow === "publish" ? "" : "secondary"}`} type="button" onClick={() => setCurrentFlow("publish")}>立即发布</button>
          <button className={`button ${currentFlow === "schedule" ? "" : "secondary"}`} type="button" onClick={() => setCurrentFlow("schedule")}>定时发布</button>
        </div>
      </section> : <p>{description}</p>}
      <div className="actions"><button className="button secondary" type="button" onClick={onClose}>取消</button><button className="button" type="button" disabled={anyPending} onClick={submit}>{anyPending ? "提交中…" : "确认"}</button></div>
    </section>
  </div>;
}

function scopeLabel(scopeType: CampaignScopeType, scopeId: string | null): string {
  if (scopeType === "global") return "全服";
  return `${scopeType === "set" ? "系列" : "SKU"} ${scopeId ?? "—"}`;
}
