"use client";

import type { PackOpeningDto, PlayerTournamentDto, PlayerTournamentRegistrationDto, PlayerTournamentResultDto, PlayerTournamentRoundDto, TournamentDto, TournamentHistoryItemDto, TournamentRegistrationDto, TournamentSettlementDto } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";
import { apiRequest } from "./client";

type PackGrant = { id: string; tournamentId: string; packId: string; status: "available" | "claimed"; createdAt: string; claimedAt: string | null };
type PlayerMode = "game" | "tabletop";
type RoundResultInput = { winnerRegistrationId: string | null; draw: boolean; forfeitedRegistrationIds: string[] };

export const tournamentsApi = {
  list: (token: string) => apiRequest<{ items: TournamentDto[] }>("/v1/tournaments", { accessToken: token }),
  history: (token: string) => apiRequest<{ items: TournamentHistoryItemDto[] }>("/v1/tournaments/history", { accessToken: token }),
  registration: (token: string, tournamentId: string) => apiRequest<{ registration: TournamentRegistrationDto }>(`/v1/tournaments/${tournamentId}/registration`, { accessToken: token }),
  result: (token: string, tournamentId: string) => apiRequest<{ result: TournamentSettlementDto }>(`/v1/tournaments/${tournamentId}/result`, { accessToken: token }),
  register: (token: string, tournamentId: string, deckId: string, key: string) => apiRequest<{ registration: TournamentRegistrationDto }>(`/v1/tournaments/${tournamentId}/register`, { method: "POST", accessToken: token, idempotencyKey: key, body: { deckId } }),
  grants: (token: string) => apiRequest<{ items: PackGrant[] }>("/v1/tournament-pack-grants", { accessToken: token }),
  claimGrant: (token: string, grantId: string, key: string) => apiRequest<{ opening: PackOpeningDto }>(`/v1/tournament-pack-grants/${grantId}/claim`, { method: "POST", accessToken: token, idempotencyKey: key }),
  playerGrants: (token: string) => apiRequest<{ items: PackGrant[] }>("/v1/player-tournament-pack-grants", { accessToken: token }),
  claimPlayerGrant: (token: string, grantId: string, key: string) => apiRequest<{ opening: PackOpeningDto }>(`/v1/player-tournament-pack-grants/${grantId}/claim`, { method: "POST", accessToken: token, idempotencyKey: key }),
  playerList: (token: string) => apiRequest<{ items: PlayerTournamentDto[] }>("/v1/player-tournaments", { accessToken: token }),
  player: (token: string, id: string) => apiRequest<{ tournament: PlayerTournamentDto }>(`/v1/player-tournaments/${id}`, { accessToken: token }),
  playerRegistrations: (token: string, id: string) => apiRequest<{ items: PlayerTournamentRegistrationDto[] }>(`/v1/player-tournaments/${id}/registrations`, { accessToken: token }),
  playerRounds: (token: string, id: string) => apiRequest<{ items: PlayerTournamentRoundDto[] }>(`/v1/player-tournaments/${id}/rounds`, { accessToken: token }),
  playerResult: (token: string, id: string) => apiRequest<{ result: PlayerTournamentResultDto }>(`/v1/player-tournaments/${id}/result`, { accessToken: token }),
  createPlayer: (token: string, mode: PlayerMode, name: string, key: string) => apiRequest<{ tournamentId: string }>("/v1/player-tournaments", { method: "POST", accessToken: token, idempotencyKey: key, body: { mode, name } }),
  joinPlayer: (token: string, id: string, body: { deckId: string } | { deckName: string }, key: string) => apiRequest<{ registrationId: string }>(`/v1/player-tournaments/${id}/join`, { method: "POST", accessToken: token, idempotencyKey: key, body }),
  start: (token: string, id: string, key: string) => apiRequest<{ status: "queued" }>(`/v1/player-tournaments/${id}/start`, { method: "POST", accessToken: token, idempotencyKey: key }),
  pair: (token: string, id: string, key: string) => apiRequest<{ roundIds: string[] }>(`/v1/player-tournaments/${id}/rounds`, { method: "POST", accessToken: token, idempotencyKey: key }),
  settle: (token: string, id: string, key: string) => apiRequest<{ status: "queued" | "settled" }>(`/v1/player-tournaments/${id}/settle`, { method: "POST", accessToken: token, idempotencyKey: key }),
  submitRound: (token: string, id: string, body: RoundResultInput, key: string) => apiRequest<{ status: "submitted" }>(`/v1/player-tournament-rounds/${id}/result`, { method: "POST", accessToken: token, idempotencyKey: key, body }),
  confirmRound: (token: string, id: string, key: string) => apiRequest<{ status: "confirmed_or_pending" }>(`/v1/player-tournament-rounds/${id}/confirm`, { method: "POST", accessToken: token, idempotencyKey: key })
};

function useTournamentQuery<T>(key: unknown[], run: (token: string) => Promise<T>, enabled = true) {
  const { accessToken, user } = useSession();
  return useQuery({ queryKey: ["tournaments", user?.id ?? "anonymous", ...key], queryFn: () => run(accessToken!), enabled: enabled && Boolean(accessToken && user), retry: false, refetchInterval: (query) => query.state.error ? false : 10_000, refetchIntervalInBackground: false });
}
export const useTournamentsQuery = () => useTournamentQuery(["today"], tournamentsApi.list);
export const useTournamentHistoryQuery = () => useTournamentQuery(["history"], tournamentsApi.history);
export const useTournamentRegistrationQuery = (id: string, enabled: boolean) => useTournamentQuery(["registration", id], (token) => tournamentsApi.registration(token, id), enabled);
export const useTournamentResultQuery = (id: string, enabled: boolean) => useTournamentQuery(["result", id], (token) => tournamentsApi.result(token, id), enabled);
export const useTournamentGrantsQuery = () => useTournamentQuery(["grants"], tournamentsApi.grants);
export const usePlayerTournamentGrantsQuery = () => useTournamentQuery(["player-grants"], tournamentsApi.playerGrants);
export const usePlayerTournamentsQuery = () => useTournamentQuery(["player-list"], tournamentsApi.playerList);
export const usePlayerTournamentQuery = (id: string) => useTournamentQuery(["player", id], (token) => tournamentsApi.player(token, id));
export const usePlayerTournamentRegistrationsQuery = (id: string) => useTournamentQuery(["player", id, "registrations"], (token) => tournamentsApi.playerRegistrations(token, id));
export const usePlayerTournamentRoundsQuery = (id: string) => useTournamentQuery(["player", id, "rounds"], (token) => tournamentsApi.playerRounds(token, id));
export const usePlayerTournamentResultQuery = (id: string) => useTournamentQuery(["player", id, "result"], (token) => tournamentsApi.playerResult(token, id));

/** 同一意图的重试复用幂等键；成功只刷新服务端真相，不在浏览器推导赛果、奖励或锁定。 */
export function useTournamentCommand<TInput, TResult>(run: (token: string, input: TInput, key: string) => Promise<TResult>) {
  const { accessToken, user } = useSession(); const client = useQueryClient(); const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  return useMutation({ mutationFn: (input: TInput) => { const fingerprint = JSON.stringify(input); if (!intent.current || intent.current.fingerprint !== fingerprint) intent.current = { fingerprint, key: createIdempotencyKey() }; return run(accessToken!, input, intent.current.key); }, onSuccess: () => { if (user) void client.invalidateQueries({ queryKey: ["tournaments", user.id] }); void client.invalidateQueries({ queryKey: ["decks", user?.id] }); void client.invalidateQueries({ queryKey: ["inventory", user?.id] }); void client.invalidateQueries({ queryKey: ["archive", user?.id] }); void client.invalidateQueries({ queryKey: ["ledger", user?.id] }); void client.invalidateQueries({ queryKey: ["onboarding", user?.id] }); intent.current = null; } });
}
