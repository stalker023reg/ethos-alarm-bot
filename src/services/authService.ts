import axios from 'axios';
import {
  createUser,
  getUserAlertPreferences as getStoredUserAlertPreferences,
  getUserByTelegramId as getStoredUserByTelegramId,
  getUserStatsSummary,
  query,
  unlinkUserByTelegramId,
  updateAlertPreference,
  updateAlertsEnabled,
  updateUser,
  getGlobalBotStats,
  updateProfileAddress,
} from '../db/db';
import type { UserAlertPreferences, UserRecord } from '../db/models';
import { ethosClient } from '../ethos/ethosClient';
import { logger } from '../utils/logger';
import { TtlCache } from '../utils/cache';

interface UserRow {
  id: string;
  tg_id: string;
  profile_id: string | null;
  wallet_address: string | null;
  x_username: string | null;
  privy_token: string | null;
  alerts_enabled: boolean;
  alerts_reviews_enabled: boolean;
  alerts_vouches_enabled: boolean;
  alerts_slash_enabled: boolean;
  alerts_snapshot_enabled: boolean;
  alerts_xp_enabled: boolean;
  last_xp: number;
  last_rank: number | null;
  created_at: Date;
}

interface EthosSearchUser {
  profileId?: number | string | null;
  username?: string | null;
  xUsername?: string | null;
  userkeys?: string[];
}

interface EthosSearchResponse {
  users?: EthosSearchUser[];
}

export interface WatchedUser {
  profileId: string;
  username: string;
}

interface EthosProfileUser {
  profileId?: number | string | null;
  username?: string | null;
  xUsername?: string | null;
  score?: number | string | null;
  xpTotal?: number | string | null;
  weeklyXp?: number | string | null;
  xpRank?: number | string | null;
  rank?: number | string | null;
  xpStreakDays?: number | string | null;
  humanVerificationStatus?: string | null;
  mommyPawnshopBingo?: string | null;
  validatorNftCount?: number | string | null;
  stats?: {
    review?: {
      received?: {
        negative?: number | string | null;
        neutral?: number | string | null;
        positive?: number | string | null;
      };
    };
    vouch?: {
      given?: {
        count?: number | string | null;
      };
      received?: {
        count?: number | string | null;
      };
    };
    xp?: {
      weekly?: number | string | null;
      rank?: number | string | null;
    };
  };
}

type UnknownRecord = Record<string, unknown>;

export interface EthosProfileSummary {
  profileId: string;
  username: string;
  score: number;
  totalXp: number;
  weeklyXp: number | null;
  rank: number | null;
  xpStreakDays: number;
  verified: boolean;
  reviewCount: number;
  positiveReviewPercent: number;
  receivedVouchCount: number;
  givenVouchCount: number;
  influenceFactor: number;
  slashCount: number;
  isValidator: boolean;
  validatorRank: number | null;
  categoryRanks: Array<{ rank: number, name: string }>;
}

export class EthosUserNotFoundError extends Error {
  constructor(username: string) {
    super(`Ethos user not found for X username: ${username}`);
    this.name = 'EthosUserNotFoundError';
  }
}

export class EthosAmbiguousUserError extends Error {
  constructor(username: string) {
    super(`Multiple users found for X username: ${username}`);
    this.name = 'EthosAmbiguousUserError';
  }
}

export class EthosUserAlreadyLinkedError extends Error {
  constructor(public existingUsername: string) {
    super(`User is already linked to ${existingUsername}`);
    this.name = 'EthosUserAlreadyLinkedError';
  }
}

export class EthosApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EthosApiError';
  }
}

function normalizeUsername(username: string): string {
  return username.replace(/^@/, '').trim().toLowerCase();
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function readPath(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;

  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function readFirstNumber(source: unknown, paths: readonly (readonly string[])[]): number | null {
  for (const path of paths) {
    const value = readPath(source, path);
    const parsed = asFiniteNumber(value);

    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function extractSearchUsers(payload: EthosSearchResponse | EthosSearchUser[] | undefined): EthosSearchUser[] {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.users)) {
    return payload.users;
  }

  if (Array.isArray((payload as any).values)) {
    return (payload as any).values;
  }

  if (Array.isArray((payload as any).items)) {
    return (payload as any).items;
  }

  const anyArray = Object.values(payload).find(Array.isArray);
  return anyArray ? (anyArray as EthosSearchUser[]) : [];
}

/**
 * Manages Telegram user registration and profile lookup state.
 */
export class AuthService {
  async upsertTelegramUser(params: {
    telegramId: string;
    xUsername?: string;
    profileId?: string;
    privyToken?: string;
  }): Promise<UserRecord> {
    const result = await query<UserRow>(
      `
      INSERT INTO users (tg_id, profile_id, x_username)
      VALUES ($1, $2, $3)
      ON CONFLICT (tg_id)
      DO UPDATE SET
        profile_id = COALESCE(EXCLUDED.profile_id, users.profile_id),
        x_username = COALESCE(EXCLUDED.x_username, users.x_username)
      RETURNING id, tg_id, profile_id, wallet_address, x_username, privy_token, alerts_enabled, alerts_reviews_enabled, alerts_vouches_enabled, alerts_slash_enabled, alerts_snapshot_enabled, alerts_xp_enabled, last_notification_ts, last_xp, last_rank, created_at
      `,
      [
        params.telegramId,
        params.profileId ?? null,
        params.xUsername ?? null,
      ],
    );

    return this.mapUser(result.rows[0]);
  }

  async getUserByTelegramId(telegramId: string): Promise<UserRecord | null> {
    return getStoredUserByTelegramId(telegramId);
  }

  async linkUser(tgId: number, xUsername: string): Promise<UserRecord> {
    const existingUser = await getStoredUserByTelegramId(String(tgId));
    if (existingUser && existingUser.profile_id) {
      throw new EthosUserAlreadyLinkedError(existingUser.x_username || existingUser.profile_id.toString());
    }

    const resolvedUser = await this.resolveEthosUserByUsername(xUsername);

    if (existingUser) {
      const updatedUser = await updateUser({
        tgId: String(tgId),
        profileId: resolvedUser.profileId,
        xUsername: resolvedUser.username,
      });

      if (resolvedUser.walletAddress) {
        await updateProfileAddress(resolvedUser.profileId, resolvedUser.walletAddress);
      }

      return updatedUser!;
    }

    const newUser = await createUser({
      tgId: String(tgId),
      profileId: resolvedUser.profileId,
      xUsername: resolvedUser.username,
    });

    if (resolvedUser.walletAddress) {
      await updateProfileAddress(resolvedUser.profileId, resolvedUser.walletAddress);
    }

    return newUser;
  }

  async getGlobalStats() {
    return getGlobalBotStats();
  }

  async resolveEthosUserByUsername(username: string): Promise<WatchedUser & { walletAddress?: string }> {
    const queryTerm = username.startsWith('@') ? username.slice(1) : username;
    
    // Support numeric profileId queries directly
    if (/^\d+$/.test(queryTerm) && !username.startsWith('@')) {
      try {
        const summary = await this.getProfileSummary(queryTerm);
        return {
          profileId: summary.profileId,
          username: summary.username,
        };
      } catch {
        // Fall back to search if direct lookup fails
      }
    }

    const response = await ethosClient.get<EthosSearchResponse>(`/users/search?query=${queryTerm}`);
    const users = extractSearchUsers(response.data);

    if (users.length === 0) {
      throw new EthosUserNotFoundError(username);
    }

    const match = this.selectExactUserMatch(users, queryTerm.toLowerCase());
    const profileId = match.profileId ? String(match.profileId) : null;
    const resolvedUsername = match.xUsername || match.username || queryTerm;
    const walletAddress = match.userkeys?.find(k => k.startsWith('address:'))?.split(':')[1]?.toLowerCase();

    if (!profileId) {
       // If no profileId, we can't fully track them, but let's see if we have an internal id
       const internalId = (match as any).id;
       if (!internalId) {
          throw new EthosUserNotFoundError(username);
       }
       // We'll return n/a or let it fail downstream if profileId is strictly required
    }

    return {
      profileId: profileId || 'n/a',
      username: resolvedUsername,
      walletAddress,
    };
  }

  // Cache profile summaries for 5 minutes to reduce duplicate API calls
  private static profileCache = new TtlCache<EthosProfileSummary>(5 * 60 * 1000);

  async getProfileSummary(profileId: string): Promise<EthosProfileSummary> {
    const cached = AuthService.profileCache.get(profileId);
    if (cached) return cached;

    const response = await ethosClient.post<EthosProfileUser[]>('/users/by/profile-id', {
      profileIds: [Number(profileId)],
    });
    const user = response.data?.[0];

    if (!user?.profileId) {
      throw new EthosApiError('Ethos profile not found');
    }

    const positiveReviews = asFiniteNumber(user.stats?.review?.received?.positive) ?? 0;
    const neutralReviews = asFiniteNumber(user.stats?.review?.received?.neutral) ?? 0;
    const negativeReviews = asFiniteNumber(user.stats?.review?.received?.negative) ?? 0;
    const reviewCount = positiveReviews + neutralReviews + negativeReviews;
    // Match Ethos website: positive / (positive + negative), excluding neutrals
    const ratedCount = positiveReviews + negativeReviews;
    const positiveReviewPercent = ratedCount > 0
      ? Number(((positiveReviews / ratedCount) * 100).toFixed(2))
      : 0;
    const verifiedStatuses = new Set(['APPROVED', 'REQUESTED', 'VERIFIED', 'CONFIRMED', 'COMPLETED']);

    let slashCount = 0;
    let validatorRank = null;
    let categoryRanks: Array<{ rank: number, name: string }> = [];
    try {
      const [statsRes, trpcRes] = await Promise.all([
        ethosClient.get(`https://api.ethos.network/api/v1/users/profileId:${profileId}/stats`),
        ethosClient.get(`https://api.ethos.network/api/v2/trpc/users.getUserRanksAmongCategories?input=${encodeURIComponent(JSON.stringify({ json: { userkey: `profileId:${profileId}` } }))}`)
      ]);
      slashCount = statsRes.data?.data?.slashes?.count ?? 0;
      const ranks = trpcRes.data?.result?.data?.json?.categoryRanks || [];

      categoryRanks = ranks
        .filter((r: any) => typeof r.rank === 'number' && r.category?.name)
        .map((r: any) => ({
          rank: r.rank,
          name: r.category.name,
        }));

      const valCat = ranks.find((r: any) => r.category?.slug === 'validators');
      validatorRank = valCat?.rank ?? null;
    } catch (err) {
      logger.error('Failed to fetch extended stats', { error: String(err) });
    }

    const summary: EthosProfileSummary = {
      profileId: String(user.profileId),
      username: user.xUsername?.trim() || user.username?.trim() || profileId,
      score: asFiniteNumber(user.score) ?? 0,
      totalXp: asFiniteNumber(user.xpTotal) ?? 0,
      weeklyXp: readFirstNumber(user, [
        ['weeklyXp'],
        ['xpWeekly'],
        ['stats', 'xp', 'weekly'],
      ]),
      rank: readFirstNumber(user, [
        ['xpRank'],
        ['rank'],
        ['stats', 'xp', 'rank'],
      ]),
      xpStreakDays: asFiniteNumber(user.xpStreakDays) ?? 0,
      verified:
        (asFiniteNumber(user.validatorNftCount) ?? 0) > 0
        || verifiedStatuses.has((user.humanVerificationStatus ?? '').toUpperCase())
        || verifiedStatuses.has((user.mommyPawnshopBingo ?? '').toUpperCase()),
      reviewCount,
      positiveReviewPercent,
      receivedVouchCount: asFiniteNumber(user.stats?.vouch?.received?.count) ?? 0,
      givenVouchCount: asFiniteNumber(user.stats?.vouch?.given?.count) ?? 0,
      influenceFactor: asFiniteNumber((user as any).influenceFactor) ?? 0,
      slashCount,
      isValidator: (asFiniteNumber(user.validatorNftCount) ?? 0) > 0,
      validatorRank,
      categoryRanks,
    };

    AuthService.profileCache.set(profileId, summary);
    return summary;
  }

  async setAlertsEnabled(telegramId: string, enabled: boolean): Promise<UserRecord | null> {
    return updateAlertsEnabled(telegramId, enabled);
  }

  async getAlertPreferences(telegramId: string): Promise<UserAlertPreferences | null> {
    return getStoredUserAlertPreferences(telegramId);
  }

  async setAlertPreference(
    telegramId: string,
    preference: 'alerts_enabled' | 'alerts_reviews_enabled' | 'alerts_vouches_enabled' | 'alerts_slash_enabled' | 'alerts_snapshot_enabled' | 'alerts_xp_enabled',
    enabled: boolean,
  ): Promise<UserAlertPreferences | null> {
    return updateAlertPreference(telegramId, preference, enabled);
  }

  async unlinkUser(telegramId: string): Promise<UserRecord | null> {
    return unlinkUserByTelegramId(telegramId);
  }

  async getUserStats(userId: number): Promise<{
    trackedUsers: number;
    notificationsSent: number;
    lastUpdate: Date | null;
  }> {
    return getUserStatsSummary(userId);
  }

  private selectExactUserMatch(users: EthosSearchUser[], username: string): EthosSearchUser {
    // 1. Try exact username/xUsername match (case-insensitive)
    const exactMatches = users.filter((user) => this.matchesXUsername(user, username));

    if (exactMatches.length > 1) {
      // If multiple matches, prioritize the one with a profileId
      const withProfileId = exactMatches.filter(u => u.profileId);
      if (withProfileId.length === 1) return withProfileId[0];
      throw new EthosAmbiguousUserError(username);
    }

    if (exactMatches.length === 1) {
      return exactMatches[0];
    }

    // 2. Try exact userkey match (service:x.com:handle or address:0x...)
    const strictUserkeyMatches = users.filter((user) => this.matchesStrictUserkey(user, username));

    if (strictUserkeyMatches.length > 1) {
       const withProfileId = strictUserkeyMatches.filter(u => u.profileId);
       if (withProfileId.length === 1) return withProfileId[0];
       throw new EthosAmbiguousUserError(username);
    }

    if (strictUserkeyMatches.length === 1) {
      return strictUserkeyMatches[0];
    }

    // 3. Last resort: if only one user returned, and it partially matches or the query was exact enough
    if (users.length === 1) {
        return users[0];
    }

    throw new EthosUserNotFoundError(username);
  }

  private matchesXUsername(user: EthosSearchUser, username: string): boolean {
    const actualUsername = user.xUsername || user.username || '';
    return normalizeUsername(actualUsername) === username;
  }

  private matchesStrictUserkey(user: EthosSearchUser, username: string): boolean {
    const lowerQuery = username.toLowerCase();
    const keys = (user.userkeys || []).map(k => k.trim().toLowerCase());
    
    return keys.includes(`service:x.com:${lowerQuery}`) || 
           keys.includes(`address:${lowerQuery}`) ||
           keys.includes(`profileid:${lowerQuery}`);
  }

  private mapUser(row: UserRow): UserRecord {
    return {
      id: Number(row.id),
      tg_id: row.tg_id,
      profile_id: row.profile_id,
      wallet_address: row.wallet_address,
      x_username: row.x_username,
      privy_token: row.privy_token,
      alerts_enabled: row.alerts_enabled,
      alerts_reviews_enabled: row.alerts_reviews_enabled,
      alerts_vouches_enabled: row.alerts_vouches_enabled,
      alerts_slash_enabled: row.alerts_slash_enabled,
      alerts_snapshot_enabled: row.alerts_snapshot_enabled,
      alerts_xp_enabled: row.alerts_xp_enabled,
      last_xp: row.last_xp,
      last_rank: row.last_rank,
      created_at: row.created_at,
    };
  }
}

const authService = new AuthService();

export async function upsertTelegramUser(params: {
  telegramId: string;
  xUsername?: string;
  profileId?: string;
  privyToken?: string;
}): Promise<UserRecord> {
  return authService.upsertTelegramUser(params);
}
