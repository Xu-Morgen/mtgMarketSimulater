"use client";

import type { AdminMarketParametersDto, AdminPackRulePreviewDto, MtgjsonImportDraftDto, MtgjsonImportDraftSummaryDto } from "@mtg-market/contracts";
import { useState } from "react";
import {
  useAdminImportDraftsQuery,
  useAdminMarketParametersQuery,
  useAdminSeriesQuery,
  useCreateSetlistDraftMutation,
  useDisablePackMutation,
  useDiscardImportDraftMutation,
  usePreviewImportDraftMutation,
  usePreviewPackRuleMutation,
  usePublishPackRuleMutation,
  useSetSkuTradableMutation,
  useUpdateMarketParametersMutation
} from "../../api/admin-api";
import type { PackRuleDefinition } from "../../api/admin-api";
import { ApiClientError } from "../../api/client";
import { ConfirmDialog, EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { useToast } from "../../providers/toast-provider";
import { draftStatusLabel, formatDateTime, mappingStatusLabel } from "./admin-format";
import styles from "./admin-shared.module.css";

/**
 * I30F 内容/参数页：只展示首发已实现能力——市场参数版本预览、系列/SKU 启停、MTGJSON 草稿、补充包规则。
 * 不展示人工例外来源、比赛/成就/奖励配置编辑等尚未开放的入口。
 */
export function AdminContentPage() {
  return <main className={`page ${styles.page}`}>
    <h1>内容与参数</h1>
    <p className={styles.intro}>本页只展示首发已实现的服务端能力。比赛、成就、奖励和每日/每周任务配置入口将在对应迭代上线后再开放；I33 发布后若启用 AI，才会追加 Agent 记录页面。</p>
    <MarketParametersSection />
    <SeriesSection />
    <MtgjsonDraftsSection />
    <PackRulesSection />
  </main>;
}

// ----- 市场参数 -----

function MarketParametersSection() {
  const params = useAdminMarketParametersQuery();
  const update = useUpdateMarketParametersMutation();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [form, setForm] = useState<AdminMarketParametersDto | null>(null);
  if (params.isPending) return <section className={styles.card}><h2>市场参数</h2><p>正在加载市场参数…</p></section>;
  if (params.isError) return <section className={styles.card}><h2>市场参数</h2><ErrorState title={params.error instanceof ApiClientError && params.error.code === "AUTHORIZATION_DENIED" ? "无权查看市场参数" : "市场参数加载失败"} onRetry={() => void params.refetch()} /></section>;
  if (!params.data) return <section className={styles.card}><h2>市场参数</h2><PageSkeleton label="正在确认市场参数访问权限" /></section>;
  const current = params.data.data;
  const draft = form ?? current;
  const set = <K extends keyof AdminMarketParametersDto>(key: K, value: AdminMarketParametersDto[K]) => setForm((prev) => ({ ...(prev ?? current), [key]: value }));
  const beginEdit = () => { setForm(current); setEditing(true); };
  const cancel = () => { setEditing(false); setForm(null); };
  const valid = draft.eurCentToGameCreditBps >= 1 && draft.minimumPrice >= 0 && draft.npcBuySpreadBps >= 0 && draft.npcSellSpreadBps >= 0 && draft.npcFeeBps >= 0;
  const submit = () => update.mutate({
    eurCentToGameCreditBps: draft.eurCentToGameCreditBps, minimumPrice: draft.minimumPrice,
    npcBuySpreadBps: draft.npcBuySpreadBps, npcSellSpreadBps: draft.npcSellSpreadBps, npcFeeBps: draft.npcFeeBps,
    expectedVersion: current.version
  }, {
    onSuccess: () => { showToast("市场参数已更新并触发重价任务。"); setConfirm(false); setEditing(false); setForm(null); },
    onError: (error) => { const message = error instanceof ApiClientError && error.code === "VERSION_STALE" ? "参数版本已变更，请重新加载后编辑。" : error instanceof Error ? error.message : "更新失败"; showToast(message, "error"); setConfirm(false); }
  });
  return <section className={styles.card}>
    <h2>市场参数（版本 {current.version}）</h2>
    <p className={styles.intro}>修改会以乐观版本号提交，服务端校验通过后投递 market.reprice，不会改写外部价格快照。</p>
    <dl className={styles.details}>
      <div><dt>规则版本</dt><dd className={styles.mono}>{current.ruleVersion}</dd></div>
      <div><dt>EUR 分→游戏币换算（bps）</dt><dd>{editing ? <input type="number" aria-label="EUR 换算" value={draft.eurCentToGameCreditBps} onChange={(event) => set("eurCentToGameCreditBps", Number.parseInt(event.target.value, 10))} /> : current.eurCentToGameCreditBps}</dd></div>
      <div><dt>最低价</dt><dd>{editing ? <input type="number" aria-label="最低价" value={draft.minimumPrice} onChange={(event) => set("minimumPrice", Number.parseInt(event.target.value, 10))} /> : current.minimumPrice}</dd></div>
      <div><dt>NPC 买价点差（bps）</dt><dd>{editing ? <input type="number" aria-label="NPC 买价点差" value={draft.npcBuySpreadBps} onChange={(event) => set("npcBuySpreadBps", Number.parseInt(event.target.value, 10))} /> : current.npcBuySpreadBps}</dd></div>
      <div><dt>NPC 卖价点差（bps）</dt><dd>{editing ? <input type="number" aria-label="NPC 卖价点差" value={draft.npcSellSpreadBps} onChange={(event) => set("npcSellSpreadBps", Number.parseInt(event.target.value, 10))} /> : current.npcSellSpreadBps}</dd></div>
      <div><dt>NPC 手续费（bps）</dt><dd>{editing ? <input type="number" aria-label="NPC 手续费" value={draft.npcFeeBps} onChange={(event) => set("npcFeeBps", Number.parseInt(event.target.value, 10))} /> : current.npcFeeBps}</dd></div>
      <div><dt>最近更新</dt><dd>{formatDateTime(current.updatedAt)}</dd></div>
    </dl>
    <div className={styles.actions}>
      {!editing ? <button className="button secondary" type="button" onClick={beginEdit}>编辑参数</button> : <>
        <button className="button" type="button" disabled={!valid || update.isPending} onClick={() => setConfirm(true)}>{update.isPending ? "提交中…" : "预览并提交"}</button>
        <button className="button secondary" type="button" onClick={cancel}>取消</button>
      </>}
    </div>
    <ConfirmDialog open={confirm} title="确认更新市场参数？" description={`将以期望版本 ${current.version} 提交；版本过期时服务端会拒绝并要求重新加载。`} onCancel={() => setConfirm(false)} onConfirm={submit} />
  </section>;
}

// ----- 系列/SKU 启停 -----

function SeriesSection() {
  const series = useAdminSeriesQuery();
  const tradable = useSetSkuTradableMutation();
  const { showToast } = useToast();
  const [skuId, setSkuId] = useState("");
  const [confirm, setConfirm] = useState<null | { skuId: string; tradable: boolean }>(null);
  if (series.isPending) return <section className={styles.card}><h2>系列与 SKU 启停</h2><p>正在加载系列…</p></section>;
  if (series.isError) return <section className={styles.card}><h2>系列与 SKU 启停</h2><ErrorState title={series.error instanceof ApiClientError && series.error.code === "AUTHORIZATION_DENIED" ? "无权查看系列" : "系列加载失败"} onRetry={() => void series.refetch()} /></section>;
  if (!series.data) return <section className={styles.card}><h2>系列与 SKU 启停</h2><PageSkeleton label="正在确认系列访问权限" /></section>;
  const items = series.data.data.items;
  const submit = () => {
    if (!confirm) return;
    tradable.mutate({ skuId: confirm.skuId, tradable: confirm.tradable }, {
      onSuccess: () => { showToast(confirm.tradable ? "SKU 已设为可交易。" : "SKU 已设为不可交易。"); setConfirm(null); setSkuId(""); },
      onError: (error) => { showToast(error instanceof Error ? error.message : "更新失败", "error"); setConfirm(null); }
    });
  };
  return <section className={styles.card}>
    <h2>系列与 SKU 启停</h2>
    <p className={styles.intro}>只切换 card_skus.tradable，不改目录或外部价格快照。人工例外来源创建命令尚未开放。</p>
    {items.length === 0 ? <EmptyState title="暂无系列">尚未导入任何系列。</EmptyState> : <div className={styles.tableWrap}><table><thead><tr><th>系列代码</th><th>名称</th><th>启用 SKU 数</th></tr></thead><tbody>{items.map((entry) => <tr key={entry.code}><td className={styles.mono}>{entry.code}</td><td>{entry.name}</td><td>{entry.enabledSkuCount}</td></tr>)}</tbody></table></div>}
    <h3>切换单个 SKU 交易状态</h3>
    <div className={styles.filterGrid}>
      <label>SKU ID<input aria-label="SKU ID" value={skuId} onChange={(event) => setSkuId(event.target.value)} placeholder="目标 SKU UUID" /></label>
      <div className={styles.actions}>
        <button className="button" type="button" disabled={!skuId.trim() || tradable.isPending} onClick={() => setConfirm({ skuId: skuId.trim(), tradable: true })}>设为可交易</button>
        <button className="button secondary" type="button" disabled={!skuId.trim() || tradable.isPending} onClick={() => setConfirm({ skuId: skuId.trim(), tradable: false })}>设为不可交易</button>
      </div>
    </div>
    <ConfirmDialog open={confirm !== null} title={confirm?.tradable ? "确认设为可交易？" : "确认设为不可交易？"} description={`将切换 SKU ${confirm?.skuId ?? ""} 的可交易状态并写入审计；不会改动价格或库存。`} onCancel={() => setConfirm(null)} onConfirm={submit} />
  </section>;
}

// ----- MTGJSON 草稿 -----

function MtgjsonDraftsSection() {
  const drafts = useAdminImportDraftsQuery(25, 0);
  const create = useCreateSetlistDraftMutation();
  const preview = usePreviewImportDraftMutation();
  const discard = useDiscardImportDraftMutation();
  const { showToast } = useToast();
  const [sourceVersion, setSourceVersion] = useState("");
  const [checksum, setChecksum] = useState("");
  const [codes, setCodes] = useState("");
  const [selected, setSelected] = useState<MtgjsonImportDraftSummaryDto | null>(null);
  if (drafts.isPending) return <section className={styles.card}><h2>MTGJSON 导入草稿</h2><p>正在加载草稿…</p></section>;
  if (drafts.isError) return <section className={styles.card}><h2>MTGJSON 导入草稿</h2><ErrorState title={drafts.error instanceof ApiClientError && drafts.error.code === "AUTHORIZATION_DENIED" ? "无权查看导入草稿" : "草稿加载失败"} onRetry={() => void drafts.refetch()} /></section>;
  if (!drafts.data) return <section className={styles.card}><h2>MTGJSON 导入草稿</h2><PageSkeleton label="正在确认草稿访问权限" /></section>;
  const items = drafts.data.data.items;
  const submitCreate = () => create.mutate({
    sourceVersion: sourceVersion.trim(), sourceChecksumSha256: checksum.trim() || null,
    setlist: codes.split(/[\s,，;]+/).filter(Boolean).map((code) => ({ code: code.toUpperCase(), name: code.toUpperCase() }))
  }, {
    onSuccess: () => { showToast("SetList 草稿已创建，请在列表中预览映射。"); setSourceVersion(""); setChecksum(""); setCodes(""); },
    onError: (error) => showToast(error instanceof Error ? error.message : "草稿创建失败", "error")
  });
  return <section className={styles.card}>
    <h2>MTGJSON 导入草稿</h2>
    <p className={styles.intro}>草稿只在服务端下载并校验后才保存；本页绝不直接改写目录、库存或外部价格快照。发布阶段延后实现，首发支持创建、预览映射与丢弃。</p>
    <h3>新建 SetList 草稿</h3>
    <div className={styles.filterGrid}>
      <label>来源版本<input aria-label="来源版本" value={sourceVersion} onChange={(event) => setSourceVersion(event.target.value)} placeholder="例如 2026-07-31" /></label>
      <label>SHA-256 校验和（可选）<input aria-label="校验和" value={checksum} onChange={(event) => setChecksum(event.target.value)} placeholder="64 位十六进制" /></label>
      <label>系列代码（逗号或空格分隔）<input aria-label="系列代码" value={codes} onChange={(event) => setCodes(event.target.value)} placeholder="例如 ONE, MID" /></label>
      <div className={styles.actions}><button className="button" type="button" disabled={!sourceVersion.trim() || !codes.trim() || create.isPending} onClick={submitCreate}>{create.isPending ? "提交中…" : "创建草稿"}</button></div>
    </div>
    <h3>已有草稿</h3>
    {items.length === 0 ? <EmptyState title="暂无导入草稿">尚未创建 MTGJSON 导入草稿。</EmptyState> : <div className={styles.tableWrap}><table><thead><tr><th>草稿 ID</th><th>来源版本</th><th>映射状态</th><th>草稿状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>
      {items.map((draft) => <DraftRow key={draft.id} draft={draft} disabled={preview.isPending || discard.isPending} onPreview={(id) => preview.mutate(id, { onSuccess: (response) => { setSelected(response.data); showToast("映射预览已更新。"); }, onError: (error) => showToast(error instanceof Error ? error.message : "预览失败", "error") })} onDiscard={(id) => discard.mutate(id, { onSuccess: () => showToast("草稿已丢弃。"), onError: (error) => showToast(error instanceof Error ? error.message : "丢弃失败", "error") })} />)}
    </tbody></table></div>}
    {selected ? <DraftPreviewDialog summary={selected} onClose={() => setSelected(null)} /> : null}
  </section>;
}

function DraftRow({ draft, disabled, onPreview, onDiscard }: { draft: MtgjsonImportDraftDto; disabled: boolean; onPreview: (id: string) => void; onDiscard: (id: string) => void }) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const canAct = draft.status === "draft" || draft.status === "validated";
  return <>
    <tr>
      <td className={styles.mono}>{draft.id}</td>
      <td className={styles.mono}>{draft.sourceVersion}</td>
      <td><span className={styles[draft.mappingStatus]}>{mappingStatusLabel(draft.mappingStatus)}</span></td>
      <td>{draftStatusLabel(draft.status)}</td>
      <td className={styles.mono}>{formatDateTime(draft.updatedAt)}</td>
      <td><div className={styles.actions}>
        <button className="button secondary" type="button" disabled={disabled || !canAct} onClick={() => onPreview(draft.id)}>预览映射</button>
        <button className="button secondary" type="button" disabled={disabled || !canAct} onClick={() => setConfirmDiscard(true)}>丢弃</button>
      </div></td>
    </tr>
    <ConfirmDialog open={confirmDiscard} title="确认丢弃草稿？" description={`将丢弃草稿 ${draft.id}，已发布的目录不受影响。`} onCancel={() => setConfirmDiscard(false)} onConfirm={() => { setConfirmDiscard(false); onDiscard(draft.id); }} />
  </>;
}

function DraftPreviewDialog({ summary, onClose }: { summary: MtgjsonImportDraftSummaryDto; onClose: () => void }) {
  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="draft-preview-title">
      <h2 id="draft-preview-title">草稿映射预览</h2>
      <dl className={styles.details}>
        <div><dt>可导入</dt><dd>{summary.importableCount}</dd></div>
        <div><dt>缺失</dt><dd>{summary.missingCount}</dd></div>
        <div><dt>冲突</dt><dd>{summary.conflictCount}</dd></div>
      </dl>
      {summary.items.length === 0 ? <p>没有映射项。</p> : <div className={styles.tableWrap}><table><thead><tr><th>系列代码</th><th>名称</th><th>状态</th><th>说明</th></tr></thead><tbody>
        {summary.items.map((item) => <tr key={item.setCode}><td className={styles.mono}>{item.setCode}</td><td>{item.name}</td><td>{item.status}</td><td>{item.detail ?? "—"}</td></tr>)}
      </tbody></table></div>}
      <p className={styles.intro}>仅展示摘要项；不含 Provider 原始响应或密钥。发布命令尚未开放。</p>
      <div className="actions"><button className="button secondary" type="button" onClick={onClose}>关闭</button></div>
    </section>
  </div>;
}

// ----- 补充包规则 -----

function PackRulesSection() {
  const preview = usePreviewPackRuleMutation();
  const publish = usePublishPackRuleMutation();
  const disable = useDisablePackMutation();
  const { showToast } = useToast();
  const [packId, setPackId] = useState("");
  const [version, setVersion] = useState("pack-rule/v1");
  const [pools, setPools] = useState("");
  const [slots, setSlots] = useState("");
  const [result, setResult] = useState<AdminPackRulePreviewDto | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [disableId, setDisableId] = useState("");
  const [disableReason, setDisableReason] = useState("");
  const [confirmDisable, setConfirmDisable] = useState(false);
  let definition: PackRuleDefinition | null = null;
  try { definition = { version: version.trim(), pools: JSON.parse(pools || "[]"), slots: JSON.parse(slots || "[]") }; }
  catch { definition = null; }
  const runPreview = () => {
    if (!definition) { showToast("补充包规则 JSON 解析失败，请检查 pools/slots 字段。", "error"); return; }
    preview.mutate({ packId: packId.trim(), definition }, {
      onSuccess: (response) => { setResult(response.data); if (!response.data.valid) showToast("服务端校验未通过，请按问题列表修正。", "error"); },
      onError: (error) => showToast(error instanceof Error ? error.message : "预览失败", "error")
    });
  };
  const runPublish = () => {
    if (!definition) { showToast("补充包规则 JSON 解析失败。", "error"); return; }
    publish.mutate({ packId: packId.trim(), definition }, {
      onSuccess: () => { showToast("补充包规则已发布为不可变版本。"); setConfirmPublish(false); },
      onError: (error) => { const message = error instanceof ApiClientError && error.code === "RESOURCE_CONFLICT" ? "规则版本已存在，不可原地覆盖。" : error instanceof Error ? error.message : "发布失败"; showToast(message, "error"); setConfirmPublish(false); }
    });
  };
  const runDisable = () => disable.mutate({ packId: disableId.trim(), reason: disableReason.trim() }, {
    onSuccess: () => { showToast("补充包已停用。"); setConfirmDisable(false); setDisableId(""); setDisableReason(""); },
    onError: (error) => showToast(error instanceof Error ? error.message : "停用失败", "error")
  });
  return <section className={styles.card}>
    <h2>补充包规则</h2>
    <p className={styles.intro}>补充包规则以不可变 (pack_id, version) 快照发布，发布后只能停用或发布新版本；本表单要求手工填写 JSON 定义，便于核对候选池/卡位/权重。</p>
    <div className={styles.filterGrid}>
      <label>补充包 ID<input aria-label="补充包 ID" value={packId} onChange={(event) => setPackId(event.target.value)} placeholder="目标补充包 UUID" /></label>
      <label>规则版本字符串<input aria-label="规则版本" value={version} onChange={(event) => setVersion(event.target.value)} placeholder="例如 pack-rule/v1" /></label>
      <label>pools（JSON 数组）<textarea aria-label="pools JSON" rows={4} value={pools} onChange={(event) => setPools(event.target.value)} placeholder='[{"id":"common","rarity":"common","candidates":[{"skuId":"...","weight":1}]}]' /></label>
      <label>slots（JSON 数组）<textarea aria-label="slots JSON" rows={4} value={slots} onChange={(event) => setSlots(event.target.value)} placeholder='[{"id":"slot-1","draws":1,"poolWeights":[{"poolId":"common","weight":1}]}]' /></label>
    </div>
    <div className={styles.actions}>
      <button className="button secondary" type="button" disabled={!packId.trim() || preview.isPending || definition === null} onClick={runPreview}>{preview.isPending ? "预览中…" : "服务端预览"}</button>
      <button className="button" type="button" disabled={!packId.trim() || !result?.valid || publish.isPending || definition === null} onClick={() => setConfirmPublish(true)}>{publish.isPending ? "发布中…" : "发布"}</button>
    </div>
    {result ? <section className={styles.notice} aria-label="补充包规则预览">
      <h3>预览结果（previewVersion {result.previewVersion}）</h3>
      <p>{result.valid ? "服务端校验通过。" : "校验未通过。"}候选池规模 {result.candidatePoolSize}。</p>
      {result.issues.length > 0 ? <ul>{result.issues.map((issue, index) => <li key={index} className={styles.failure}>{issue}</li>)}</ul> : null}
      {result.slots.length > 0 ? <div className={styles.tableWrap}><table><thead><tr><th>卡位</th><th>抽取数</th><th>稀有度概率</th></tr></thead><tbody>
        {result.slots.map((slot) => <tr key={slot.id}><td className={styles.mono}>{slot.id}</td><td>{slot.draws}</td><td>{slot.rarityProbabilities.map((prob) => `${prob.rarity} ${(prob.probabilityBasisPoints / 100).toFixed(2)}%`).join("、")}</td></tr>)}
      </tbody></table></div> : null}
    </section> : null}
    <h3>停用补充包</h3>
    <div className={styles.filterGrid}>
      <label>补充包 ID<input aria-label="停用补充包 ID" value={disableId} onChange={(event) => setDisableId(event.target.value)} /></label>
      <label>停用原因<input aria-label="停用原因" value={disableReason} onChange={(event) => setDisableReason(event.target.value)} /></label>
      <div className={styles.actions}><button className="button secondary" type="button" disabled={!disableId.trim() || !disableReason.trim() || disable.isPending} onClick={() => setConfirmDisable(true)}>{disable.isPending ? "提交中…" : "停用"}</button></div>
    </div>
    <ConfirmDialog open={confirmPublish} title="确认发布补充包规则？" description={`将发布不可变版本 ${version.trim()}；重复版本会被服务端拒绝。`} onCancel={() => setConfirmPublish(false)} onConfirm={runPublish} />
    <ConfirmDialog open={confirmDisable} title="确认停用补充包？" description={`将停用补充包 ${disableId.trim()} 并写入审计。`} onCancel={() => setConfirmDisable(false)} onConfirm={runDisable} />
  </section>;
}
