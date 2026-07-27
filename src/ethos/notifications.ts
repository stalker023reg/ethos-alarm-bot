import { createHash } from 'node:crypto';
import { isAxiosError } from 'axios';
import { logger } from '../utils/logger';
import { buildEthosRequestConfig, ethosClient, type EthosAuthOptions } from './ethosClient';

export interface EthosNotification {
  id: string;
  type?: string;
  title?: string;
  body?: string;
  createdAt?: string;
  readAt?: string | null;
  metadata?: Record<string, unknown>;
  slashId?: number | string;
}

export interface NotificationsResponse {
  notifications: EthosNotification[];
  nextCursor?: string | null;
}

interface ProfileActivitiesResponse {
  values?: any[];
  items?: any[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readUnknownPath(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;

  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function readStringPath(source: unknown, paths: readonly (readonly string[])[]): string | null {
  for (const path of paths) {
    const value = readUnknownPath(source, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function readNumberPath(source: unknown, paths: readonly (readonly string[])[]): number | null {
  for (const path of paths) {
    const value = readUnknownPath(source, path);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function normalizeCreatedAt(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    const timestamp = new Date(value);
    if (!Number.isNaN(timestamp.getTime())) {
      return timestamp.toISOString();
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(normalized).toISOString();
  }

  return undefined;
}

function extractActivityValues(payload: ProfileActivitiesResponse | any): any[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.values)) {
    return payload.values;
  }

  if (Array.isArray(payload?.items)) {
    return payload.items;
  }

  return [];
}

function normalizeActivityType(item: any): string {
  const rawType = readStringPath(item, [
    ['type'],
    ['activityType'],
    ['kind'],
    ['name'],
    ['verb'],
    ['eventType'],
    ['endorsementType'],
    ['data', 'type'],
    ['data', 'activityType'],
    ['data', 'kind'],
    ['data', 'name'],
    ['data', 'verb'],
    ['activity', 'type'],
    ['activity', 'activityType'],
    ['activity', 'kind'],
    ['activity', 'name'],
    ['activity', 'verb'],
    ['metadata', 'activityType'],
    ['metadata', 'type'],
    ['metadata', 'kind'],
    ['metadata', 'verb'],
  ]);

  return rawType?.toLowerCase() ?? 'unknown';
}

function mapActivityItem(profileScope: string, item: any): EthosNotification {
  const typeMap: Record<string, string> = {
    'vouch': 'VOUCH',
    'review': 'REVIEW',
    'positive': 'REVIEW',
    'negative': 'REVIEW',
    'neutral': 'REVIEW',
    'slash': 'SLASH_CREATE',
    'comment': 'REPLY',
    'reply': 'REPLY',
    'xp-tip': 'XP_TIP',
  };

  const rawType = normalizeActivityType(item);
  const mappedType = typeMap[rawType] || 'UNKNOWN';
  const isoDate = normalizeCreatedAt(item.timestamp ?? item.createdAt ?? item.updatedAt) ?? new Date(0).toISOString();
  const authorDisplayName =
    readStringPath(item, [
      ['authorUser', 'displayName'],
      ['authorUser', 'name'],
      ['author', 'displayName'],
      ['author', 'name'],
    ]) ?? '';
  const authorUsername =
    readStringPath(item, [
      ['authorUser', 'username'],
      ['author', 'username'],
      ['authorUser', 'xUsername'],
      ['author', 'xUsername'],
    ]) ?? '';
  const authorXUsername =
    readStringPath(item, [
      ['authorUser', 'xUsername'],
      ['author', 'xUsername'],
      ['authorUser', 'username'],
      ['author', 'username'],
    ]) ?? '';
  const targetDisplayName =
    readStringPath(item, [
      ['subjectUser', 'displayName'],
      ['subjectUser', 'name'],
      ['subject', 'displayName'],
      ['subject', 'name'],
    ]) ?? '';
  const targetUsername =
    readStringPath(item, [
      ['subjectUser', 'username'],
      ['subject', 'username'],
      ['subjectUser', 'xUsername'],
      ['subject', 'xUsername'],
    ]) ?? '';
  const targetXUsername =
    readStringPath(item, [
      ['subjectUser', 'xUsername'],
      ['subject', 'xUsername'],
      ['subjectUser', 'username'],
      ['subject', 'username'],
    ]) ?? '';
  const comment = item.data?.comment || item.data?.text || item.translation?.translatedContent || '';
  const amount = item.data?.deposited || item.data?.amount || '0';

  // Extract sentiment score from various possible locations
  let rawScore = item.data?.score ?? item.data?.rating;
  let score: number | undefined;

  if (typeof rawScore === 'number') {
    score = rawScore;
  } else if (typeof rawScore === 'string') {
    const lower = rawScore.toLowerCase();
    if (lower.includes('positive')) score = 1;
    else if (lower.includes('negative')) score = -1;
    else if (lower.includes('neutral')) score = 0;
    else {
      const parsed = Number(rawScore);
      if (Number.isFinite(parsed)) score = parsed;
    }
  }

  if (score === undefined || score === null) {
    // If score is missing, try to derive it from endorsementType or rawType
    const endorsementType = (
      readStringPath(item, [['endorsementType'], ['data', 'endorsementType']]) ||
      rawType
    ).toUpperCase();

    if (endorsementType.includes('POSITIVE')) {
      score = 1;
    } else if (endorsementType.includes('NEGATIVE')) {
      score = -1;
    } else if (endorsementType.includes('NEUTRAL')) {
      score = 0;
    }
  }

  const eventLink = readStringPath(item, [
    ['link'],
    ['data', 'link'],
    ['metadata', 'link'],
  ]);
  const stableIdSource = [
    profileScope,
    rawType,
    item.id ?? '',
    item.data?.id ?? '',
    item.timestamp ?? item.createdAt ?? item.updatedAt ?? '',
    authorUsername,
    targetUsername,
    comment,
    String(amount),
  ].join('|');

  return {
    id: String(
      item.data?.id
      ?? item.id
      ?? createHash('sha1').update(stableIdSource).digest('hex')
    ),
    type: mappedType,
    createdAt: isoDate,
    slashId: (mappedType === 'SLASH_CREATE' || mappedType === 'SLASH_COMPLETE') ? item.data?.id : undefined,
    metadata: {
      author: {
        displayName: authorDisplayName || undefined,
        username: authorUsername || undefined,
        xUsername: authorXUsername || undefined,
      },
      target: {
        displayName: targetDisplayName || undefined,
        username: targetUsername || undefined,
        xUsername: targetXUsername || undefined,
      },
      comment,
      score,
      amount,
      link: eventLink ?? undefined,
      profileId: item.subjectProfileId ? String(item.subjectProfileId) : undefined,
      targetProfileId: item.subjectProfileId ? String(item.subjectProfileId) : undefined,
    }
  };
}

/**
 * Fetches the authenticated user's Ethos notifications feed.
 */
export async function getMyNotifications(auth: EthosAuthOptions): Promise<NotificationsResponse> {
  const response = await ethosClient.get<NotificationsResponse>(
    '/notifications/me',
    buildEthosRequestConfig(auth),
  );

  return response.data;
}

/**
 * Fetches public activity for a given profile ID.
 */
export async function getPublicActivity(profileId: string): Promise<EthosNotification[]> {
  try {
    const response = await ethosClient.post<ProfileActivitiesResponse>('/activities/profile/received', {
      userkey: `profileId:${profileId}`,
      filter: ['vouch', 'review'],
      excludeHistorical: false,
      excludeSpam: true,
      limit: 100,
      offset: 0,
      orderBy: {
        field: 'timestamp',
        direction: 'desc',
      },
    });
    const values = extractActivityValues(response.data);
    logger.info('Ethos public activity fetched', {
      profileId,
      count: values.length,
      source: 'activities/profile/received',
    });

    return values.map((item: any) => mapActivityItem(`profile:${profileId}`, item));
  } catch (error) {
    logger.error('Failed to fetch Ethos public activity', {
      profileId,
      error: error instanceof Error ? error.message : String(error),
      status: isAxiosError(error) ? error.response?.status : undefined,
      data: isAxiosError(error) ? error.response?.data : undefined,
    });
    return [];
  }
}

/**
 * Fetches the global public slash activity feed.
 */
export async function getGlobalSlashActivity(): Promise<EthosNotification[]> {
  try {
    const response = await ethosClient.post('/activities/feed', {
      filter: ['slash'],
      excludeSpam: true,
      excludeUnverified: false,
      limit: 20,
      offset: 0,
      orderBy: {
        field: 'timestamp',
        direction: 'desc',
      },
    });

    const values = response.data?.values ?? [];
    logger.info('Ethos global slash activity fetched', {
      count: values.length,
    });

    return values.map((item: any) => mapActivityItem('global:slash', item));
  } catch (error) {
    logger.error('Failed to fetch Ethos global slash activity', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Fetches a slash activity by its onchain transaction hash.
 */
export async function getSlashActivityByTxHash(txHash: string): Promise<EthosNotification | null> {
  try {
    const response = await ethosClient.get(`/activities/slash/tx/${txHash}`);
    const payload = response.data;

    const id =
      readNumberPath(payload, [['id'], ['activityId'], ['slashId']])
      ?? readStringPath(payload, [['id'], ['activityId'], ['slashId']])
      ?? txHash;

    const authorDisplayName = readStringPath(payload, [
      ['authorUser', 'displayName'],
      ['authorUser', 'name'],
      ['author', 'displayName'],
      ['author', 'name'],
      ['user', 'displayName'],
      ['user', 'name'],
    ]);

    const authorUsername = readStringPath(payload, [
      ['authorUser', 'username'],
      ['authorUser', 'xUsername'],
      ['author', 'username'],
      ['author', 'xUsername'],
      ['user', 'username'],
      ['user', 'xUsername'],
    ]);

    const targetDisplayName = readStringPath(payload, [
      ['subjectUser', 'displayName'],
      ['subjectUser', 'name'],
      ['targetUser', 'displayName'],
      ['targetUser', 'name'],
      ['target', 'displayName'],
      ['target', 'name'],
      ['subject', 'displayName'],
      ['subject', 'name'],
    ]);

    const targetUsername = readStringPath(payload, [
      ['subjectUser', 'username'],
      ['subjectUser', 'xUsername'],
      ['targetUser', 'username'],
      ['targetUser', 'xUsername'],
      ['target', 'username'],
      ['target', 'xUsername'],
      ['subject', 'username'],
      ['subject', 'xUsername'],
    ]);

    const comment = readStringPath(payload, [
      ['comment'],
      ['body'],
      ['description'],
      ['metadata', 'comment'],
    ]);
    const title = readStringPath(payload, [
      ['title'],
      ['subject'],
      ['metadata', 'title'],
      ['reason'],
    ]);

    const link = readStringPath(payload, [
      ['link'],
      ['activityLink'],
      ['metadata', 'link'],
    ]);

    const score = readNumberPath(payload, [
      ['amount'],
      ['score'],
      ['severity'],
      ['metadata', 'amount'],
    ]);

    return {
      id: `slash:${String(id)}`,
      type: 'SLASH_CREATE',
      slashId: id,
      title: title ?? undefined,
      createdAt: normalizeCreatedAt(
        readUnknownPath(payload, ['createdAt'])
        ?? readUnknownPath(payload, ['timestamp'])
        ?? readUnknownPath(payload, ['updatedAt']),
      ),
      metadata: {
        author: {
          displayName: authorDisplayName ?? undefined,
          username: authorUsername ?? 'unknown',
          xUsername: authorUsername ?? undefined,
        },
        target: {
          displayName: targetDisplayName ?? undefined,
          username: targetUsername ?? 'unknown',
          xUsername: targetUsername ?? undefined,
        },
        comment: comment ?? '',
        amount: score ?? 0,
        txHash,
        link: link ?? undefined,
        source: 'ethos-activity',
      },
    };
  } catch (error) {
    logger.warn('Failed to enrich slash activity by tx hash', {
      txHash,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Fetches a vouch or review activity by its onchain transaction hash.
 */
export async function getSocialActivityByTxHash(txHash: string): Promise<EthosNotification | null> {
  try {
    // Ethos API often uses the same pattern for activity enrichment by tx
    const response = await ethosClient.get(`/activities/tx/${txHash}`);
    const item = response.data;
    
    if (!item) return null;

    return mapActivityItem('onchain:tx', item);
  } catch (error) {
    logger.warn('Failed to enrich social activity by tx hash', {
      txHash,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
