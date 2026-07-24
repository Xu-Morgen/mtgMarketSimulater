"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { type UseFormRegisterReturn, useForm } from "react-hook-form";
import { z } from "zod";
import { useLoginMutation, useRegisterMutation } from "../../api/auth-mutations";
import { ApiClientError } from "../../api/client";
import { useToast } from "../../providers/toast-provider";

const password = z.string().min(12, "密码至少需要 12 个字符").max(128, "密码不能超过 128 个字符");
const loginSchema = z.object({ email: z.string().trim().email("请输入有效邮箱"), password });
const registerSchema = loginSchema.extend({ displayName: z.string().trim().min(2, "显示名称至少需要 2 个字符").max(40, "显示名称不能超过 40 个字符") });
type LoginValues = z.infer<typeof loginSchema>; type RegisterValues = z.infer<typeof registerSchema>;
/** 登录结果中的服务端角色是唯一权威：管理员一律进入管理首页，不接受 URL 重定向指令。 */
function safeNext(next: string | null, role: "player" | "admin") {
  const localNext = next?.startsWith("/") && !next.startsWith("//") ? next : null;
  if (role === "admin") return "/admin";
  return localNext && !localNext.startsWith("/admin") ? localNext : "/dashboard";
}
function ServerError({ error }: { error: unknown }) { if (!error) return null; return <p className="form-error" role="alert">{error instanceof ApiClientError ? error.message : "网络异常，请稍后重试"}</p>; }
function PasswordField({ autoComplete, registration }: { autoComplete: "current-password" | "new-password"; registration: UseFormRegisterReturn<"password"> }) { const [visible, setVisible] = useState(false); const id = useId(); return <div><span className="password-label-row"><label htmlFor={id}>密码</label><button aria-label={visible ? "隐藏密码输入内容" : "显示密码输入内容"} aria-pressed={visible} className="password-toggle" type="button" onClick={() => setVisible((value) => !value)}>{visible ? "隐藏" : "显示"}</button></span><input id={id} autoComplete={autoComplete} type={visible ? "text" : "password"} {...registration} /></div>; }
export function LoginForm() { const form = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } }); const login = useLoginMutation(); const router = useRouter(); const query = useSearchParams(); const { showToast } = useToast(); return <form className="auth-form" onSubmit={form.handleSubmit((values) => login.mutate(values, { onSuccess: ({ data }) => { showToast("登录成功"); router.replace(safeNext(query?.get("next") ?? null, data.user.role)); } }))}><label>邮箱<input autoComplete="email" type="email" {...form.register("email")} /></label>{form.formState.errors.email && <p className="field-error">{form.formState.errors.email.message}</p>}<PasswordField autoComplete="current-password" registration={form.register("password")} />{form.formState.errors.password && <p className="field-error">{form.formState.errors.password.message}</p>}<ServerError error={login.error} /><button className="button" disabled={login.isPending} type="submit">{login.isPending ? "正在登录…" : "登录"}</button></form>; }
export function RegisterForm() { const form = useForm<RegisterValues>({ resolver: zodResolver(registerSchema), defaultValues: { displayName: "", email: "", password: "" } }); const register = useRegisterMutation(); const router = useRouter(); const { showToast } = useToast(); return <form className="auth-form" onSubmit={form.handleSubmit((values) => register.mutate(values, { onSuccess: ({ data }) => { showToast("注册成功，已为你建立会话"); router.replace(safeNext(null, data.user.role)); } }))}><label>显示名称<input autoComplete="nickname" {...form.register("displayName")} /></label>{form.formState.errors.displayName && <p className="field-error">{form.formState.errors.displayName.message}</p>}<label>邮箱<input autoComplete="email" type="email" {...form.register("email")} /></label>{form.formState.errors.email && <p className="field-error">{form.formState.errors.email.message}</p>}<PasswordField autoComplete="new-password" registration={form.register("password")} /><p className="field-help">至少 12 个字符。</p>{form.formState.errors.password && <p className="field-error">{form.formState.errors.password.message}</p>}<ServerError error={register.error} /><button className="button" disabled={register.isPending} type="submit">{register.isPending ? "正在注册…" : "创建账号"}</button></form>; }
