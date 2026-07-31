"use client";

import type { AdminCompensationResultDto, AdminUserListItemDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useState } from "react";
import {
  useAdminUserDetailQuery,
  useAdminUsersQuery,
  useCompensateBalanceMutation,
  useCompensateInventoryMutation,
  useFreezeUserMutation,
  useRevokeUserSessionsMutation,
  useUnfreezeUserMutation
} from "../../api/admin-api";
import { ApiClientError } from "../../api/client";
import { EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { useToast } from "../../providers/toast-provider";
import { formatDateTime } from "./admin-format";
import styles from "./admin-shared.module.css";

/** I30F 玩家数据管理：检索/详情、冻结/解冻、会话撤销与补偿修正（原因 → 预览 → 二次确认 → 查看新流水/审计）。 */
export function AdminUsersPage() {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"player" | "admin" | "">("");
  const [status, setStatus] = useState<"active" | "frozen" | "">("");
  const [applied, setApplied] = useState<{ username: string; role: "player" | "admin" | ""; status: "active" | "frozen" | "" }>({ username: "", role: "", status: "" });
  const [detailId, setDetailId] = useState<string | null>(null);
  const users = useAdminUsersQuery({
    username: applied.username || undefined,
    role: applied.role === "" ? undefined : applied.role,
    status: applied.status === "" ? undefined : applied.status,
    limit: 25, offset: 0
  });
  const apply = () => setApplied({ username: username.trim(), role, status });
  const reset = () => { setUsername(""); setRole(""); setStatus(""); setApplied({ username: "", role: "", status: "" }); };
  return <main className={`page ${styles.page}`}>
    <h1>玩家数据管理</h1>
    <p className={styles.intro}>支持按用户名、角色和状态检索；冻结/解冻与会话撤销显示服务端返回状态。补偿修正只提交补偿命令，不接收“最终余额/最终库存”自由编辑，并展示新生成流水与原始关联记录。</p>
    <div className={styles.filterGrid}>
      <label>用户名或邮箱<input aria-label="用户名或邮箱" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="支持模糊匹配" /></label>
      <label>角色<select aria-label="角色筛选" value={role} onChange={(event) => setRole(event.target.value as "player" | "admin" | "")}><option value="">全部</option><option value="player">玩家</option><option value="admin">管理员</option></select></label>
      <label>账户状态<select aria-label="账户状态筛选" value={status} onChange={(event) => setStatus(event.target.value as "active" | "frozen" | "")}><option value="">全部</option><option value="active">正常</option><option value="frozen">已冻结</option></select></label>
      <div className={styles.actions}><button className="button" type="button" onClick={apply}>检索</button><button className="button secondary" type="button" onClick={reset}>清除</button></div>
    </div>
    {users.isPending ? <PageSkeleton label="正在检索玩家" /> : users.isError ? <ErrorState title={users.error instanceof ApiClientError && users.error.code === "AUTHORIZATION_DENIED" ? "无权检索玩家" : "玩家检索失败"} onRetry={() => void users.refetch()} /> : !users.data ? <PageSkeleton label="正在确认检索权限" /> : users.data.data.items.length === 0 ? <EmptyState title="没有匹配的玩家">调整检索条件后重试。</EmptyState> : <div className={styles.tableWrap}><table><thead><tr><th>用户 ID</th><th>邮箱</th><th>显示名</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>
      {users.data.data.items.map((user) => <UserListRow key={user.id} user={user} onOpen={() => setDetailId(user.id)} />)}
    </tbody></table></div>}
    {detailId ? <UserDetailDialog id={detailId} onClose={() => setDetailId(null)} /> : null}
  </main>;
}

function UserListRow({ user, onOpen }: { user: AdminUserListItemDto; onOpen: () => void }) {
  return <tr>
    <td className={styles.mono}>{user.id}</td>
    <td>{user.email}</td>
    <td>{user.displayName}</td>
    <td>{user.role === "admin" ? "管理员" : "玩家"}</td>
    <td>{user.frozen ? <span className={styles.paused}>已冻结</span> : <span className={styles.published}>正常</span>}</td>
    <td className={styles.mono}>{formatDateTime(user.createdAt)}</td>
    <td><button className="button secondary" type="button" onClick={onOpen}>查看详情</button></td>
  </tr>;
}

function UserDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useAdminUserDetailQuery(id);
  const freeze = useFreezeUserMutation();
  const unfreeze = useUnfreezeUserMutation();
  const revoke = useRevokeUserSessionsMutation();
  const { showToast } = useToast();
  const [freezeFlow, setFreezeFlow] = useState(false);
  const [freezeReason, setFreezeReason] = useState("");
  const [revokeFlow, setRevokeFlow] = useState(false);
  const [compKind, setCompKind] = useState<null | "balance" | "inventory">(null);
  const [compResult, setCompResult] = useState<AdminCompensationResultDto | null>(null);
  if (detail.isPending) return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true"><p>正在加载玩家详情…</p><div className="actions"><button className="button secondary" type="button" onClick={onClose}>关闭</button></div></section></div>;
  if (detail.isError || !detail.data) return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true"><p className={styles.failure}>详情加载失败。</p><div className="actions"><button className="button secondary" type="button" onClick={onClose}>关闭</button></div></section></div>;
  const user = detail.data.data.user;
  const anyPending = freeze.isPending || unfreeze.isPending || revoke.isPending;
  const submitFreeze = () => freeze.mutate({ id, reason: freezeReason.trim() }, { onSuccess: () => { showToast("已冻结玩家。"); setFreezeFlow(false); setFreezeReason(""); }, onError: (error) => showToast(error instanceof Error ? error.message : "冻结失败", "error") });
  const submitUnfreeze = () => unfreeze.mutate(id, { onSuccess: () => showToast("已解冻玩家。"), onError: (error) => showToast(error instanceof Error ? error.message : "解冻失败", "error") });
  const submitRevoke = () => revoke.mutate(id, { onSuccess: () => { showToast("已撤销玩家全部会话。"); setRevokeFlow(false); }, onError: (error) => showToast(error instanceof Error ? error.message : "会话撤销失败", "error") });
  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="user-detail-title">
      <h2 id="user-detail-title">玩家详情</h2>
      <dl className={styles.details}>
        <div><dt>用户 ID</dt><dd className={styles.mono}>{user.id}</dd></div>
        <div><dt>邮箱</dt><dd>{user.email}</dd></div>
        <div><dt>显示名</dt><dd>{user.displayName}</dd></div>
        <div><dt>角色</dt><dd>{user.role === "admin" ? "管理员" : "玩家"}</dd></div>
        <div><dt>账户状态</dt><dd>{user.frozen ? <span className={styles.paused}>已冻结</span> : <span className={styles.published}>正常</span>}{user.frozenReason ? `（${user.frozenReason}）` : null}</dd></div>
        <div><dt>活跃会话</dt><dd>{user.activeSessionCount}</dd></div>
        <div><dt>账户余额</dt><dd>{user.accountBalance ? `总额 ${user.accountBalance.total} · 可用 ${user.accountBalance.available} · 冻结 ${user.accountBalance.frozen}` : "—"}</dd></div>
        <div><dt>创建时间</dt><dd>{formatDateTime(user.createdAt)}</dd></div>
      </dl>
      <section className={styles.notice} aria-label="账户操作">
        <h3>账户操作</h3>
        <p className={styles.intro}>冻结/解冻只改 users 行；会话撤销只改 sessions 行。补偿修正走下方独立流程，禁止直接编辑最终余额或库存。</p>
        <div className={styles.actions}>
          {user.frozen ? <button className="button" type="button" disabled={anyPending} onClick={submitUnfreeze}>{unfreeze.isPending ? "解冻中…" : "解冻"}</button> : <button className="button" type="button" disabled={anyPending} onClick={() => setFreezeFlow(true)}>{freeze.isPending ? "冻结中…" : "冻结"}</button>}
          <button className="button secondary" type="button" disabled={anyPending} onClick={() => setRevokeFlow(true)}>撤销全部会话</button>
          <button className="button secondary" type="button" onClick={() => setCompKind("balance")}>余额补偿</button>
          <button className="button secondary" type="button" onClick={() => setCompKind("inventory")}>库存补偿</button>
        </div>
        {user.recentAudit.length > 0 ? <><h4>最近审计</h4><div className={styles.tableWrap}><table><thead><tr><th>时间</th><th>动作</th><th>请求 ID</th></tr></thead><tbody>{user.recentAudit.map((entry) => <tr key={entry.id}><td>{formatDateTime(entry.occurredAt)}</td><td>{entry.action}</td><td className={styles.mono}>{entry.requestId ?? "—"}</td></tr>)}</tbody></table></div></> : null}
        <p className={styles.intro}>完整日志：<Link href={`/admin/logs?userId=${user.id}`}>按该用户筛选审计日志</Link>。</p>
      </section>
      {freezeFlow ? <FreezeDialog reason={freezeReason} setReason={setFreezeReason} pending={freeze.isPending} onCancel={() => { setFreezeFlow(false); setFreezeReason(""); }} onConfirm={submitFreeze} /> : null}
      {revokeFlow ? <RevokeDialog pending={revoke.isPending} onCancel={() => setRevokeFlow(false)} onConfirm={submitRevoke} /> : null}
      {compKind ? <CompensationDialog userId={id} kind={compKind} onClose={() => { setCompKind(null); setCompResult(null); }} onResult={setCompResult} result={compResult} /> : null}
      <div className="actions"><button className="button secondary" type="button" onClick={onClose}>关闭</button></div>
    </section>
  </div>;
}

function FreezeDialog({ reason, setReason, pending, onCancel, onConfirm }: { reason: string; setReason: (value: string) => void; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <section className={styles.notice} aria-label="冻结确认">
    <h3>冻结玩家</h3>
    <p className={styles.intro}>冻结后该玩家无法登录或进行写操作；服务端会写入审计。</p>
    <label>冻结原因（必填）<input aria-label="冻结原因" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    {!reason.trim() ? <p className={styles.fieldError}>请填写冻结原因。</p> : null}
    <div className={styles.actions}><button className="button secondary" type="button" onClick={onCancel}>取消</button><button className="button" type="button" disabled={pending || !reason.trim()} onClick={onConfirm}>{pending ? "提交中…" : "确认冻结"}</button></div>
  </section>;
}

function RevokeDialog({ pending, onCancel, onConfirm }: { pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <section className={styles.notice} aria-label="撤销会话确认">
    <h3>撤销全部会话</h3>
    <p className={styles.intro}>将使该玩家的全部 access token 与 refresh cookie 立即失效，并写入审计。</p>
    <div className={styles.actions}><button className="button secondary" type="button" onClick={onCancel}>取消</button><button className="button" type="button" disabled={pending} onClick={onConfirm}>{pending ? "提交中…" : "确认撤销"}</button></div>
  </section>;
}

function CompensationDialog({ userId, kind, result, onResult, onClose }: { userId: string; kind: "balance" | "inventory"; result: AdminCompensationResultDto | null; onResult: (result: AdminCompensationResultDto) => void; onClose: () => void }) {
  const balanceMutation = useCompensateBalanceMutation();
  const inventoryMutation = useCompensateInventoryMutation();
  const { showToast } = useToast();
  const [step, setStep] = useState<"input" | "confirm">("input");
  const [amount, setAmount] = useState("");
  const [skuId, setSkuId] = useState("");
  const [direction, setDirection] = useState<"credit" | "debit">("credit");
  const [reasonCategory, setReasonCategory] = useState("操作失误");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reasonCategoryOptions = ["操作失误", "异常损失", "活动补偿", "数据修正", "其他"];
  const magnitude = Number.parseInt(amount, 10);
  const magnitudeValid = Number.isFinite(magnitude) && magnitude > 0;
  const skuValid = kind === "balance" || skuId.trim().length > 0;
  const fullReason = `${reasonCategory}：${note.trim()}`;
  const reasonValid = note.trim().length > 0;
  const goToConfirm = () => { setError(null); setStep("confirm"); };
  const submit = () => {
    const onSuccess = (response: { data: AdminCompensationResultDto }) => { onResult(response.data); showToast("补偿已执行，已追加新流水并写入审计。"); setStep("input"); setAmount(""); setSkuId(""); setNote(""); };
    const onError = (err: unknown) => { const message = err instanceof ApiClientError ? err.response.error.message : err instanceof Error ? err.message : "补偿失败"; setError(message); showToast(message, "error"); setStep("input"); };
    if (kind === "balance") balanceMutation.mutate({ id: userId, amount: magnitude, direction, reason: fullReason }, { onSuccess, onError });
    else inventoryMutation.mutate({ id: userId, skuId: skuId.trim(), quantity: magnitude, direction, reason: fullReason }, { onSuccess, onError });
  };
  const pending = balanceMutation.isPending || inventoryMutation.isPending;
  const inputValid = magnitudeValid && skuValid && reasonValid;
  return <section className={styles.notice} aria-label={kind === "balance" ? "余额补偿" : "库存补偿"}>
    <h3>{kind === "balance" ? "余额补偿" : "库存补偿"}</h3>
    <p className={styles.intro}>{kind === "balance" ? "只提交补偿命令，禁止输入“最终余额”。服务端会经账本追加 admin_compensation 流水。" : "只提交补偿命令，禁止输入“最终库存”。服务端会经库存流水追加 admin_compensation 记录。"}</p>
    {step === "input" ? <>
      <div className={styles.filterGrid}>
        <label>原因分类<select aria-label="原因分类" value={reasonCategory} onChange={(event) => setReasonCategory(event.target.value)}>{reasonCategoryOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        <label>方向<select aria-label="补偿方向" value={direction} onChange={(event) => setDirection(event.target.value as "credit" | "debit")}><option value="credit">增加（补偿入账）</option><option value="debit">扣减（追回）</option></select></label>
        {kind === "inventory" ? <label>SKU ID<input aria-label="库存补偿 SKU ID" value={skuId} onChange={(event) => setSkuId(event.target.value)} placeholder="补正目标 SKU UUID" /></label> : null}
        <label>{kind === "balance" ? "金额（最小货币单位）" : "数量（最小单位）"}<input aria-label={kind === "balance" ? "金额" : "库存数量"} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={kind === "balance" ? "例如 1000" : "例如 1"} /></label>
        <label>说明<input aria-label="补偿说明" value={note} onChange={(event) => setNote(event.target.value)} placeholder="说明本次补偿背景" /></label>
      </div>
      {error ? <p className={styles.failure}>{error}</p> : null}
      <div className={styles.actions}><button className="button secondary" type="button" onClick={onClose}>取消</button><button className="button" type="button" disabled={!inputValid || pending} onClick={goToConfirm}>预览并确认</button></div>
    </> : <>
      <dl className={styles.details}>
        <div><dt>原因</dt><dd>{fullReason}</dd></div>
        <div><dt>方向</dt><dd>{direction === "credit" ? "增加" : "扣减"}</dd></div>
        {kind === "balance"
          ? <div><dt>金额</dt><dd className={styles.mono}>{magnitude}</dd></div>
          : <><div><dt>SKU</dt><dd className={styles.mono}>{skuId.trim()}</dd></div><div><dt>数量</dt><dd>{magnitude}</dd></div></>}
      </dl>
      <p className={styles.intro}>确认后将立即经服务端追加流水；此预览不修改任何已有流水或余额字段。</p>
      <div className={styles.actions}><button className="button secondary" type="button" onClick={() => setStep("input")}>返回修改</button><button className="button" type="button" disabled={pending} onClick={submit}>{pending ? "提交中…" : "二次确认提交"}</button></div>
    </>}
    {result ? <CompensationResult result={result} /> : null}
  </section>;
}

function CompensationResult({ result }: { result: AdminCompensationResultDto }) {
  return <section className={styles.notice} aria-label="补偿结果">
    <h3>补偿结果</h3>
    <dl className={styles.details}>
      <div><dt>审计 ID</dt><dd className={styles.mono}>{result.auditId}</dd></div>
      <div><dt>新流水 ID</dt><dd className={styles.mono}>{result.ledgerEntryId ?? result.inventoryEntryId ?? "—"}</dd></div>
      {result.newBalance ? <><div><dt>新余额总额</dt><dd>{result.newBalance.total}</dd></div><div><dt>可用</dt><dd>{result.newBalance.available}</dd></div><div><dt>冻结</dt><dd>{result.newBalance.frozen}</dd></div></> : null}
      {result.newQuantity ? <><div><dt>SKU</dt><dd className={styles.mono}>{result.newQuantity.skuId}</dd></div><div><dt>总量</dt><dd>{result.newQuantity.quantity}</dd></div><div><dt>可用</dt><dd>{result.newQuantity.available}</dd></div><div><dt>订单锁定</dt><dd>{result.newQuantity.orderLocked}</dd></div><div><dt>比赛锁定</dt><dd>{result.newQuantity.tournamentLocked}</dd></div></> : null}
    </dl>
    <p className={styles.intro}>完整流水与审计可在日志页按用户或请求 ID 检索；本结果不可作为绕过账本或库存的写入入口。</p>
  </section>;
}
