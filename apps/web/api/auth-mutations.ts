"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";

export function useLoginMutation() {
  const session = useSession();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: async (input: { email: string; password: string }) => authApi.login(input, createIdempotencyKey()), onSuccess: ({ data }) => { queryClient.clear(); session.acceptSession(data); } });
}
export function useRegisterMutation() {
  const session = useSession();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: async (input: { email: string; displayName: string; password: string }) => authApi.register(input, createIdempotencyKey()), onSuccess: ({ data }) => { queryClient.clear(); session.acceptSession(data); } });
}
export function useLogoutMutation() {
  const session = useSession();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: () => authApi.logout(session.csrfToken, createIdempotencyKey()), onSettled: () => { queryClient.clear(); session.clearSession(); } });
}
